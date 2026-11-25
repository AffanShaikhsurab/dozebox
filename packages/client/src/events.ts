// P2: the event stream. GET /v1/events, reconnect with Last-Event-ID, unknown event names read as `unknown`.
import { request } from "node:http";
import { EVENT_PING_SECONDS, normalizeEvent } from "@dozebox/protocol/v1";
import type { Delay } from "./call.ts";
import { makeSseParser, type SseMessage } from "./sse.ts";
import type { DozeboxClient, DozeboxEvent } from "./types.ts";

export const DEFAULT_IDLE_MS = EVENT_PING_SECONDS * 3 * 1000;

export type EventsDeps = {
  readonly socketPath: string;
  readonly signal?: AbortSignal | undefined;
  readonly delay: Delay;
  readonly idleMs: number;
  /** Called before every connection, so the client re-reads `hello` after a reconnect. Its failure is ignored. */
  readonly hello: () => Promise<unknown>;
};

function toEvent(m: SseMessage): DozeboxEvent | null {
  let data: unknown = m.data;
  try {
    data = JSON.parse(m.data);
  } catch {
    // kept as the raw text
  }
  const e = normalizeEvent(m.event, data);
  return e.type === "ping" ? null : e;
}

/** Resolves with whether the server accepted the stream, once it ends or fails. Never rejects. */
function stream(
  deps: EventsDeps,
  signal: AbortSignal,
  lastId: string | undefined,
  onMessage: (m: SseMessage) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let connected = false;
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (lastId !== undefined) headers["last-event-id"] = lastId;
    const req = request({ socketPath: deps.socketPath, method: "GET", path: "/v1/events", headers, signal }, (res) => {
      if (res.statusCode !== 200) return void res.resume();
      connected = true;
      res.setEncoding("utf8");
      const parser = makeSseParser(onMessage);
      res.on("data", (chunk: string) => parser.feed(chunk));
      res.on("error", () => undefined);
    });
    req.setTimeout(deps.idleMs, () => req.destroy());
    req.on("error", () => resolve(connected));
    req.on("close", () => resolve(connected));
    req.end();
  });
}

export function makeEvents(deps: EventsDeps): DozeboxClient["events"] {
  return (onEvent) => {
    const stop = new AbortController();
    const signal = deps.signal ? AbortSignal.any([stop.signal, deps.signal]) : stop.signal;
    let lastId: string | undefined;

    const onMessage = (m: SseMessage): void => {
      lastId = m.id ?? lastId;
      const e = toEvent(m);
      if (!e) return;
      try {
        onEvent(e);
      } catch {
        // a throwing listener must not end the stream
      }
    };

    void (async () => {
      let failures = 0;
      while (!signal.aborted) {
        await deps.hello().catch(() => undefined);
        if (signal.aborted) break;
        const connected = await stream(deps, signal, lastId, onMessage);
        failures = connected ? 1 : failures + 1;
        if (signal.aborted) break;
        await deps.delay(failures, signal);
      }
    })();

    return { close: () => stop.abort() };
  };
}
