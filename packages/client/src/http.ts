// P2: the error every client call rejects with. Only errors marked retryable are retried.
import type { ErrorBody } from "@dozebox/protocol/v1";

export type DozeboxErrorCode = ErrorBody["error"]["code"] | "transport";

export class DozeboxError extends Error {
  readonly code: DozeboxErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  constructor(code: DozeboxErrorCode, message: string, status: number, retryable: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = "DozeboxError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
