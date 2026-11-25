// A2: the seam between the socket transport (http.ts, events.ts) and the endpoint semantics (routes.ts). The
// transport owns sockets, body limits, JSON parsing, timeouts and the SSE stream; routes own every other endpoint.

/** Which socket a request came in on. The payload socket's file path is the caller's identity (ADR 0006). */
export type SocketKind = { readonly kind: "payload"; readonly payload: string } | { readonly kind: "admin" };

export type ProtocolRequest = {
  readonly method: string;
  /** Path without the query string, e.g. `/v1/holds/run-42`. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly socket: SocketKind;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Parsed JSON body; undefined when the request had none. */
  readonly body: unknown;
  readonly requestId: string;
};

export type ProtocolResponse = {
  readonly status: number;
  /** Sent as JSON; no body when undefined (204). */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
};

export type ProtocolHandler = (req: ProtocolRequest) => Promise<ProtocolResponse>;

/** On the admin socket, payload-scoped calls name their payload with this header. */
export const PAYLOAD_HEADER = "x-dozebox-payload";

/** One server-sent event. `id` is `<bootId>-<counter>`; `payload` set means only that payload's socket sees it. */
export type HubEvent = {
  readonly id: string;
  readonly name: string;
  readonly data: unknown;
  readonly payload: string | null;
};
