// Responses: JSON bodies, the control API error body of `@dozebox/protocol/control`, and the headers every answer
// carries. The router is the only CORS source (the Function URL has no cors block: both together duplicate
// access-control-allow-origin, notes/c3t).
import { CONTROL_ERROR_STATUS, type ControlErrorBody, type ControlErrorCode } from "@dozebox/protocol/control";
import type { FunctionUrlResult } from "./event.ts";

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** CORS for the wake page and other browser clients; tokens travel in headers, never in cookies. */
export function corsHeaders(tokenHeaders: ReadonlyArray<string>): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": ["content-type", "idempotency-key", ...tokenHeaders].join(", "),
    "access-control-max-age": "86400",
  };
}

export function respond(
  statusCode: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): FunctionUrlResult {
  return { statusCode, headers: { ...BASE_HEADERS, ...headers }, body };
}

export function json(
  statusCode: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): FunctionUrlResult {
  return respond(statusCode, JSON.stringify(value), { "content-type": "application/json", ...headers });
}

/** An error answer. `retryAfterMs` (rounded up to whole seconds) sets both `Retry-After` and `retryAfterSeconds`. */
export function errorResponse(
  code: ControlErrorCode,
  message: string,
  opts: { readonly retryAfterMs?: number; readonly headers?: Readonly<Record<string, string>> } = {},
): FunctionUrlResult {
  const { status, retryable } = CONTROL_ERROR_STATUS[code];
  const seconds = opts.retryAfterMs === undefined ? undefined : Math.max(1, Math.ceil(opts.retryAfterMs / 1000));
  const body: ControlErrorBody = {
    error: { code, message, retryable, ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }) },
  };
  return json(status, body, { ...(seconds === undefined ? {} : { "retry-after": String(seconds) }), ...opts.headers });
}
