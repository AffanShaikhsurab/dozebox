// A2: every endpoint of part 4 over HTTP on per-payload Unix sockets (`/run/dozebox/payloads/<payload>.sock`, the
// caller is the socket's payload, ADR 0006) and the admin socket (`/run/dozebox/admin.sock`, root only, any payload).
import { randomUUID } from "node:crypto";
import type { Clock } from "@dozebox/core/time";
import type { AttentionInput, Status } from "@dozebox/protocol/v1";
import type { Logger } from "../ports/log.ts";
import type { PresenceSource } from "../ports/presence.ts";
import { makeEventHub } from "./events.ts";
import { makeSocketServer, type SocketFs } from "./http.ts";
import { LIMITS } from "./limits.ts";
import { makeRoutes, type ChangeKind } from "./routes.ts";
import type { ProtocolStore } from "./store.ts";

export const SOCKET_DIR = "/run/dozebox";
export const ADMIN_SOCKET = "/run/dozebox/admin.sock";
export const PRESENCE_EVERY_MS = 30_000;
const PRESENCE_SAMPLE_MS = 2_000;
/** Runner presence sources write under this payload name; their ids start with `src:`. */
export const RUNNER_PAYLOAD = "runner";

export const socketPath = (payload: string, dir: string = SOCKET_DIR): string => `${dir}/payloads/${payload}.sock`;

/** Events the agent publishes on `GET /v1/events` (SSE). `data` is checked against EVENT_SCHEMAS. */
export type AgentEventSink = (name: string, data: unknown) => void;

export type ProtocolServerDeps = {
  readonly store: ProtocolStore;
  readonly log: Logger;
  readonly now: () => number;
  readonly clock: Clock;
  readonly bootId: string;
  readonly boxId: string;
  readonly agentVersion: string;
  /** The payload names that get a socket. */
  readonly payloads: () => ReadonlyArray<string>;
  readonly status: (payload: string | null) => Status;
  readonly presenceSources: ReadonlyArray<PresenceSource>;
  /** `POST /v1/sleep`: a person asked to sleep. Resolves refused with blockers, or accepted. */
  readonly sleep: (force: boolean) => Promise<{ readonly accepted: boolean; readonly blockers: ReadonlyArray<string> }>;
  /** `POST /v1/attention` goes to the forwarder (A7). Returns the alert id. */
  readonly attention: (payload: string, input: AttentionInput) => Promise<string>;
  readonly socketDir?: string;
  /** The payload's user, owner of its socket. Null leaves the socket to root. */
  readonly owner?: (payload: string) => { readonly uid: number; readonly gid: number } | null;
  readonly holdMaxSeconds?: (payload: string) => number;
  readonly features?: ReadonlyArray<string>;
  /** False while the box parks. Default: always true. */
  readonly accepting?: () => boolean;
  readonly onChange?: (what: ChangeKind, payload: string) => void;
  readonly ids?: () => string;
  readonly fs?: SocketFs;
};

export interface ProtocolServer {
  readonly start: () => Promise<void>;
  readonly publish: AgentEventSink;
  readonly stop: () => Promise<void>;
}

/** One sampling round: every source in parallel, each cut off after PRESENCE_SAMPLE_MS; a bad source is skipped. */
export async function samplePresence(
  deps: Pick<ProtocolServerDeps, "store" | "log" | "clock" | "presenceSources">,
  signal: AbortSignal,
): Promise<void> {
  const now = deps.clock.now();
  await Promise.all(
    deps.presenceSources.map(async (src) => {
      try {
        const cut = AbortSignal.any([signal, deps.clock.timeout(PRESENCE_SAMPLE_MS)]);
        const late = new Promise<never>((_resolve, reject) => {
          cut.addEventListener("abort", () => reject(new Error(`presence source ${src.id} took over 2 s`)), {
            once: true,
          });
        });
        void late.catch(() => {});
        const samples = await Promise.race([src.sample(now, cut), late]);
        for (const s of samples) {
          if (!s.id.startsWith("src:") || !(s.until > now)) continue;
          const until = new Date(Math.min(s.until, now + LIMITS.presenceMaxSeconds * 1000)).toISOString();
          await deps.store.putPresence(RUNNER_PAYLOAD, s.id, { until, kind: s.kind }, now);
        }
      } catch (e) {
        if (!signal.aborted) deps.log.log("warn", "presence source skipped", { source: src.id, error: e });
      }
    }),
  );
}

export function makeProtocolServer(deps: ProtocolServerDeps): ProtocolServer {
  const log = deps.log.child({ component: "protocol" });
  const dir = deps.socketDir ?? SOCKET_DIR;
  const hub = makeEventHub({ bootId: deps.bootId });
  const handle = makeRoutes({
    store: deps.store,
    now: deps.now,
    payloads: deps.payloads,
    status: deps.status,
    sleep: deps.sleep,
    attention: deps.attention,
    agentVersion: deps.agentVersion,
    boxId: deps.boxId,
    features: deps.features ?? ["events-sse"],
    holdMaxSeconds: deps.holdMaxSeconds ?? (() => LIMITS.holdMaxSeconds),
    accepting: deps.accepting ?? (() => true),
    onChange: deps.onChange ?? (() => {}),
  });
  const sockets = makeSocketServer({
    handle,
    events: hub,
    log,
    clock: deps.clock,
    ids: deps.ids ?? randomUUID,
    ...(deps.fs === undefined ? {} : { fs: deps.fs }),
  });
  const listening = new Set<string>();
  const ctl = new AbortController();
  let loop: Promise<void> = Promise.resolve();

  const syncSockets = async (): Promise<void> => {
    const want = new Set(deps.payloads());
    for (const name of want) {
      if (listening.has(name)) continue;
      const owner = deps.owner?.(name) ?? null;
      await sockets.listen({
        path: socketPath(name, dir),
        socket: { kind: "payload", payload: name },
        mode: 0o600,
        ...(owner === null ? {} : { owner }),
      });
      listening.add(name);
    }
    for (const name of listening) {
      if (want.has(name)) continue;
      await sockets.unlisten(socketPath(name, dir));
      listening.delete(name);
    }
  };

  const tick = async (): Promise<void> => {
    try {
      await syncSockets();
      await samplePresence({ ...deps, log }, ctl.signal);
    } catch (e) {
      if (!ctl.signal.aborted) log.log("warn", "protocol tick failed", { error: e });
    }
  };

  return {
    start: async () => {
      await sockets.listen({ path: `${dir}/admin.sock`, socket: { kind: "admin" }, mode: 0o600 });
      await syncSockets();
      loop = (async () => {
        for (;;) {
          await tick();
          try {
            await deps.clock.sleep(PRESENCE_EVERY_MS, ctl.signal);
          } catch {
            return;
          }
        }
      })();
    },
    publish: (name, data) => {
      hub.publish(name, data);
    },
    stop: async () => {
      ctl.abort();
      await loop;
      await sockets.close();
    },
  };
}
