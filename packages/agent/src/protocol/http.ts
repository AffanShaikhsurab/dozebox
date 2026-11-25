// A2: HTTP/1.1 over Unix sockets (part 4 §4.2). One listener per payload socket plus the admin socket. The transport
// enforces the 16 KiB body limit (413 too_large), parses JSON (400 bad_request), answers or closes within 2 s
// (500 internal), stamps `X-Request-Id`, maps a thrown handler error to 500 internal, and serves `GET /v1/events`
// (SSE: replay after `Last-Event-ID`, live events, `ping` every EVENT_PING_SECONDS). Everything else goes to `handle`.
import { chmod, chown, mkdir, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { Clock } from "@dozebox/core/time";
import { ERROR_STATUS, EVENT_PING_SECONDS, REQUEST_BODY_LIMIT_BYTES, type ErrorBody } from "@dozebox/protocol/v1";
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

type Listener = { readonly server: Server; readonly streams: Set<() => void> };

const errorBody = (code: "too_large" | "bad_request" | "internal", message: string): ErrorBody => ({
  error: { code, message, retryable: ERROR_STATUS[code].retryable },
});

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

function send(
  res: ServerResponse,
  status: number,
  requestId: string,
  body?: unknown,
  extra?: Readonly<Record<string, string>>,
) {
  const headers: Record<string, string | number> = { ...extra, "x-request-id": requestId };
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  headers["content-type"] = "application/json; charset=utf-8";
  headers["content-length"] = Buffer.byteLength(text);
  res.writeHead(status, headers);
  res.end(text);
}

type Body = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly tooLarge: boolean };

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > REQUEST_BODY_LIMIT_BYTES) {
        req.off("data", onData);
        req.resume();
        resolve({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("error", () => resolve({ ok: false, tooLarge: false }));
    req.on("end", () => {
      if (size === 0) return resolve({ ok: true, body: undefined });
      try {
        resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ ok: false, tooLarge: false });
      }
    });
  });
}

export function makeSocketServer(deps: {
  readonly handle: ProtocolHandler;
  readonly events: EventHub;
  readonly log: Logger;
  readonly clock: Clock;
  /** Request ids. */
  readonly ids: () => string;
  readonly fs?: SocketFs;
}): SocketServer {
  const fs: SocketFs = deps.fs ?? { unlink, chmod, chown, mkdir };
  const listeners = new Map<string, Listener>();

  const serveEvents = (req: IncomingMessage, res: ServerResponse, spec: SocketSpec, listener: Listener): void => {
    const viewer = spec.socket.kind === "payload" ? spec.socket.payload : null;
    const stop = new AbortController();
    const write = (e: { id: string; name: string; data: unknown }): void => {
      res.write(`id: ${e.id}\nevent: ${e.name}\ndata: ${JSON.stringify(e.data)}\n\n`);
    };
    const lastId = req.headers["last-event-id"];
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-request-id": deps.ids(),
    });
    res.flushHeaders();
    for (const e of deps.events.since(typeof lastId === "string" ? lastId : null, viewer)) write(e);
    const unsubscribe = deps.events.subscribe(viewer, write);
    const end = (): void => {
      if (stop.signal.aborted) return;
      stop.abort();
      unsubscribe();
      listener.streams.delete(end);
      res.end();
    };
    listener.streams.add(end);
    res.on("close", end);
    void (async () => {
      while (!stop.signal.aborted) {
        try {
          await deps.clock.sleep(EVENT_PING_SECONDS * 1_000, stop.signal);
        } catch {
          return;
        }
        res.write("event: ping\ndata: {}\n\n");
      }
    })();
  };

  const serveRequest = async (req: IncomingMessage, res: ServerResponse, spec: SocketSpec): Promise<void> => {
    const requestId = deps.ids();
    const fail = (code: "too_large" | "bad_request" | "internal", message: string): void =>
      send(res, ERROR_STATUS[code].status, requestId, errorBody(code, message));
    const read = await readBody(req);
    if (!read.ok) {
      if (read.tooLarge) res.setHeader("connection", "close");
      return read.tooLarge
        ? fail("too_large", "request body is too large")
        : fail("bad_request", "body is not valid JSON");
    }
    const url = new URL(req.url ?? "/", "http://dozebox");
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
    const done = new AbortController();
    const timedOut = deps.clock.sleep(SERVER_TIMEOUT_MS, done.signal).then(
      () => "timeout" as const,
      () => "cancelled" as const,
    );
    const handled = deps.handle({
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      socket: spec.socket,
      headers,
      body: read.body,
      requestId,
    });
    try {
      const out = await Promise.race([handled, timedOut]);
      if (out === "timeout" || out === "cancelled") {
        deps.log.log("warn", "handler timed out", { requestId, method: req.method, path: url.pathname });
        handled.catch(() => undefined);
        return fail("internal", "request timed out");
      }
      send(res, out.status, requestId, out.body, out.headers);
    } catch (e) {
      deps.log.log("error", "handler failed", { requestId, method: req.method, path: url.pathname, error: String(e) });
      fail("internal", "internal error");
    } finally {
      done.abort();
    }
  };

  const onRequest = (spec: SocketSpec, listener: Listener) => (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://dozebox").pathname;
    if (req.method === "GET" && pathname === "/v1/events") return serveEvents(req, res, spec, listener);
    void serveRequest(req, res, spec).catch((e: unknown) => {
      deps.log.log("error", "transport failed", { error: String(e) });
      res.destroy();
    });
  };

  const unlisten = async (path: string): Promise<void> => {
    const listener = listeners.get(path);
    if (!listener) return;
    listeners.delete(path);
    for (const end of listener.streams) end();
    const closed = new Promise<void>((resolve) => listener.server.close(() => resolve()));
    listener.server.closeAllConnections();
    await closed;
    await fs.unlink(path).catch((e: unknown) => {
      if (!isMissing(e)) throw e;
    });
  };

  return {
    listen: async (spec) => {
      await unlisten(spec.path);
      await fs.mkdir(dirname(spec.path), { recursive: true, mode: 0o755 });
      await fs.unlink(spec.path).catch((e: unknown) => {
        if (!isMissing(e)) throw e;
      });
      const listener: Listener = { server: createServer(), streams: new Set() };
      listener.server.on("request", onRequest(spec, listener));
      await new Promise<void>((resolve, reject) => {
        listener.server.once("error", reject);
        listener.server.listen(spec.path, () => {
          listener.server.off("error", reject);
          resolve();
        });
      });
      listeners.set(spec.path, listener);
      await fs.chmod(spec.path, spec.mode ?? 0o600);
      if (spec.owner) await fs.chown(spec.path, spec.owner.uid, spec.owner.gid);
    },
    unlisten,
    close: async () => {
      await Promise.all([...listeners.keys()].map(unlisten));
    },
  };
}
