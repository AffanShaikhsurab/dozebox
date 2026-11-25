// P2: the client, built from injectable deps (timers, delays) so tests are deterministic.
import {
  normalizeStatus,
  ProtocolDecodeError,
  type AttentionAccepted,
  type Hello,
  type Hold,
  type Wake,
} from "@dozebox/protocol/v1";
import { DEFAULT_ATTEMPTS, expectRecord, jitteredDelay, makeCaller, type Delay } from "./call.ts";
import { DEFAULT_IDLE_MS, makeEvents } from "./events.ts";
import { everyInterval, makeKeepHold, type Every } from "./holds.ts";
import { DozeboxError, errorOf, isRecord } from "./http.ts";
import type { DozeboxClient } from "./types.ts";

export type ClientDeps = {
  readonly socketPath: string;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly attempts?: number;
  readonly delay?: Delay;
  readonly every?: Every;
  readonly now?: () => number;
  readonly idleMs?: number;
};

const seg = (id: string): string => encodeURIComponent(id);

export function makeClient(deps: ClientDeps): DozeboxClient {
  const { exchange, json } = makeCaller({
    socketPath: deps.socketPath,
    timeoutMs: deps.timeoutMs ?? 2000,
    signal: deps.signal,
    attempts: deps.attempts ?? DEFAULT_ATTEMPTS,
    delay: deps.delay ?? jitteredDelay,
  });
  const done = async (method: "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<void> => {
    await json(method, path, body);
  };

  const hello: DozeboxClient["hello"] = async () => expectRecord<Hello>(await json("GET", "/v1/hello"), "hello");
  const hold: DozeboxClient["hold"] = async (id, input) =>
    expectRecord<Hold>(await json("PUT", `/v1/holds/${seg(id)}`, input), "hold");
  const release: DozeboxClient["release"] = (id) => done("DELETE", `/v1/holds/${seg(id)}`);

  return {
    hello,
    hold,
    release,
    status: async () => {
      const raw = await json("GET", "/v1/status");
      try {
        return normalizeStatus(raw);
      } catch (e) {
        if (e instanceof ProtocolDecodeError) throw new DozeboxError("transport", e.message, 0, false, e);
        throw e;
      }
    },
    keepHold: makeKeepHold({ hold, release, every: deps.every ?? everyInterval, now: deps.now ?? Date.now }),
    beat: (beats) => done("POST", "/v1/beats", { beats }),
    wake: async (id, input) => expectRecord<Wake>(await json("PUT", `/v1/wakes/${seg(id)}`, input), "wake"),
    cancelWake: (id) => done("DELETE", `/v1/wakes/${seg(id)}`),
    presence: (id, kind, forSeconds) =>
      done("PUT", `/v1/presence/${seg(id)}`, {
        kind,
        until: new Date((deps.now ?? Date.now)() + forSeconds * 1000).toISOString(),
      }),
    attention: async (input) =>
      expectRecord<AttentionAccepted>(await json("POST", "/v1/attention", input), "attention"),
    sleep: async (opts) => {
      const reply = await exchange("POST", "/v1/sleep", {
        reason: "user",
        ...(opts?.force === undefined ? {} : { force: opts.force }),
      });
      if (reply.status >= 200 && reply.status < 300) return { accepted: true, blockers: [] };
      const blockers = isRecord(reply.json) ? reply.json["blockers"] : undefined;
      if (reply.status === 409 && Array.isArray(blockers)) {
        return { accepted: false, blockers: blockers.filter((b): b is string => typeof b === "string") };
      }
      throw errorOf(reply);
    },
    events: makeEvents({
      socketPath: deps.socketPath,
      signal: deps.signal,
      delay: deps.delay ?? jitteredDelay,
      idleMs: deps.idleMs ?? DEFAULT_IDLE_MS,
      hello,
    }),
  };
}
