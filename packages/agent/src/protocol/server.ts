// A2: every endpoint of part 4 over HTTP on per-payload Unix sockets (`/run/dozebox/<payload>.sock`, the caller is the
// socket's payload) and the admin socket (`/run/dozebox/admin.sock`, root only, any payload).
import type { Status } from "@dozebox/protocol/v1";
import type { Logger } from "../ports/log.ts";
import type { PresenceSource } from "../ports/presence.ts";
import type { ProtocolStore } from "./store.ts";

export const SOCKET_DIR = "/run/dozebox";
export const ADMIN_SOCKET = "/run/dozebox/admin.sock";

/** Events the agent publishes on `GET /v1/events` (SSE). `data` is checked against EVENT_SCHEMAS. */
export type AgentEventSink = (name: string, data: unknown) => void;

export type ProtocolServerDeps = {
  readonly store: ProtocolStore;
  readonly log: Logger;
  readonly now: () => number;
  /** The payload names that get a socket. */
  readonly payloads: () => ReadonlyArray<string>;
  readonly status: (payload: string | null) => Status;
  readonly presenceSources: ReadonlyArray<PresenceSource>;
  /** `POST /v1/sleep`: a person asked to sleep. Resolves refused with blockers, or accepted. */
  readonly sleep: (force: boolean) => Promise<{ readonly accepted: boolean; readonly blockers: ReadonlyArray<string> }>;
  /** `POST /v1/attention` goes to the forwarder (A7). Returns the alert id. */
  readonly attention: (payload: string, input: unknown) => Promise<string>;
  readonly socketDir?: string;
};

export interface ProtocolServer {
  readonly start: () => Promise<void>;
  readonly publish: AgentEventSink;
  readonly stop: () => Promise<void>;
}

export function makeProtocolServer(_deps: ProtocolServerDeps): ProtocolServer {
  throw new Error("not implemented: A2 makeProtocolServer");
}
