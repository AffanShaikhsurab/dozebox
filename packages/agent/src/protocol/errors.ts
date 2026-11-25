// A2: a refused protocol call. The store and the routes throw it; the routes turn it into the part 4 §4.4 error body.
import { ERROR_STATUS, type ErrorBody, type ErrorCode } from "@dozebox/protocol/v1";

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly field: string | undefined;
  /** Seconds, for `rate_limited`. */
  readonly retryAfter: number | undefined;
  constructor(code: ErrorCode, message: string, opts: { readonly field?: string; readonly retryAfter?: number } = {}) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.field = opts.field;
    this.retryAfter = opts.retryAfter;
  }
}

export function errorBody(code: ErrorCode, message: string, field?: string): ErrorBody {
  const error = { code, message: message.slice(0, 500), retryable: ERROR_STATUS[code].retryable };
  return { error: field === undefined ? error : { ...error, field: field.slice(0, 120) } };
}
