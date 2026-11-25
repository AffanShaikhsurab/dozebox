// A2: HTTP/1.1 over Unix sockets (part 4 §4.2). One listener per payload socket plus the admin socket. The transport
// enforces the 16 KiB body limit (413 too_large), parses JSON (400 bad_request), answers or closes within 2 s
// (500 internal), stamps `X-Request-Id`, maps a thrown handler error to 500 internal, and serves `GET /v1/events`
// (SSE: replay after `Last-Event-ID`, live events, `ping` every EVENT_PING_SECONDS). Everything else goes to `handle`.
import type { Clock } from "@dozebox/core/time";
import type { Logger } from "../ports/log.ts";
import type { EventHub } from "./events.ts";
import type { ProtocolHandler, SocketKind } from "./wire.ts";

export const SERVER_TIMEOUT_MS = 2_000;

export type SocketSpec = {
  readonly path: string;
  readonly socket: SocketKind;
  /** chmod after listen. Default 0o600. */
  readonly mode?: number;
  /** chown after listen when set (the payload's user). */
  readonly owner?: { readonly uid: number; readonly gid: number };
};

/** The filesystem calls around a socket file; node:fs/promises in production. */
export type SocketFs = {
  readonly unlink: (path: string) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly chown: (path: string, uid: number, gid: number) => Promise<void>;
  readonly mkdir: (path: string, opts: { readonly recursive: true; readonly mode: number }) => Promise<unknown>;
};

export interface SocketServer {
  /** Removes a stale socket file first, creates the parent directory (0755), listens, then chmod and chown. */
  readonly listen: (spec: SocketSpec) => Promise<void>;
  /** Close one socket (a payload removed from the config). Unknown path is a no-op. */
  readonly unlisten: (path: string) => Promise<void>;
  /** Ends every SSE stream, closes every listener and removes the socket files. Safe to call twice. */
  readonly close: () => Promise<void>;
}

export function makeSocketServer(_deps: {
  readonly handle: ProtocolHandler;
  readonly events: EventHub;
  readonly log: Logger;
  readonly clock: Clock;
  /** Request ids. */
  readonly ids: () => string;
  readonly fs?: SocketFs;
}): SocketServer {
  throw new Error("not implemented: A2 makeSocketServer");
}
