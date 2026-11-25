// P2: one HTTP/1.1 exchange over the unix socket, and the error every client call rejects with.
import { request } from "node:http";
import { ERROR_STATUS, type ErrorBody } from "@dozebox/protocol/v1";

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

export type Method = "GET" | "PUT" | "POST" | "DELETE";
export type Reply = { readonly status: number; readonly json: unknown };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The error for a non-2xx reply. A body that is not an ErrorBody reads as `internal`, retryable from 5xx and 429. */
export function errorOf(reply: Reply): DozeboxError {
  const { status, json } = reply;
  const err = isRecord(json) ? json["error"] : undefined;
  if (isRecord(err) && typeof err["code"] === "string" && typeof err["message"] === "string") {
    const code = Object.hasOwn(ERROR_STATUS, err["code"]) ? (err["code"] as ErrorBody["error"]["code"]) : "internal";
    const retryable = typeof err["retryable"] === "boolean" ? err["retryable"] : status >= 500;
    return new DozeboxError(code, err["message"], status, retryable);
  }
  return new DozeboxError("internal", `HTTP ${status}`, status, status >= 500 || status === 429);
}

/** One attempt. Resolves with any HTTP status; rejects with a `transport` DozeboxError. */
export function send(
  socketPath: string,
  method: Method,
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const fail = (cause: unknown): void => {
      if (signal?.aborted) return reject(new DozeboxError("transport", "request aborted", 0, false, cause));
      const message = timeout.aborted ? `no answer within ${timeoutMs} ms` : "socket call failed";
      reject(new DozeboxError("transport", message, 0, true, cause));
    };
    if (signal?.aborted) return fail(signal.reason);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const headers: Record<string, string | number> = { accept: "application/json" };
    if (payload) {
      headers["content-type"] = "application/json; charset=utf-8";
      headers["content-length"] = payload.length;
    }
    const req = request(
      { socketPath, method, path, headers, signal: signal ? AbortSignal.any([timeout, signal]) : timeout },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", fail);
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = text.length > 0 ? JSON.parse(text) : undefined;
          } catch (cause) {
            if (status >= 200 && status < 300) {
              return reject(new DozeboxError("transport", "response is not JSON", status, true, cause));
            }
          }
          resolve({ status, json });
        });
      },
    );
    req.on("error", fail);
    if (payload) req.write(payload);
    req.end();
  });
}
