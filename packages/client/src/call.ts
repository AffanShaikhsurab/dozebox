// P2: retries. Only errors marked retryable (a retryable error body, a transport failure, a 5xx without a body)
// are tried again, a small fixed number of times with jittered backoff.
import { setTimeout as sleepFor } from "node:timers/promises";
import { DozeboxError, errorOf, isRecord, send, type Method, type Reply } from "./http.ts";

export type Delay = (attempt: number, signal?: AbortSignal) => Promise<void>;

export const DEFAULT_ATTEMPTS = 3;

/** 200 ms, 400 ms, ... capped at 2 s, each scaled by a random factor in [0.5, 1). */
export const jitteredDelay: Delay = async (attempt, signal) => {
  const base = Math.min(2000, 200 * 2 ** (attempt - 1));
  try {
    await sleepFor(Math.round(base * (0.5 + Math.random() / 2)), undefined, { signal });
  } catch {
    // aborted: the next attempt reports it
  }
};

export type CallDeps = {
  readonly socketPath: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly attempts: number;
  readonly delay: Delay;
};

export type Caller = {
  /** The first reply that is not a retryable failure; a retryable failure that outlasts the attempts throws. */
  readonly exchange: (method: Method, path: string, body?: unknown) => Promise<Reply>;
  /** `exchange`, throwing the error body of a non-2xx reply. */
  readonly json: <T>(method: Method, path: string, body?: unknown) => Promise<T>;
};

export function makeCaller(deps: CallDeps): Caller {
  async function exchange(method: Method, path: string, body?: unknown): Promise<Reply> {
    for (let attempt = 1; ; attempt++) {
      let failure: DozeboxError;
      try {
        const reply = await send(deps.socketPath, method, path, body, deps.timeoutMs, deps.signal);
        if (reply.status >= 200 && reply.status < 300) return reply;
        failure = errorOf(reply);
        if (!failure.retryable) return reply;
      } catch (e) {
        if (!(e instanceof DozeboxError) || !e.retryable) throw e;
        failure = e;
      }
      if (attempt >= deps.attempts) throw failure;
      await deps.delay(attempt, deps.signal);
    }
  }

  async function json<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const reply = await exchange(method, path, body);
    if (reply.status < 200 || reply.status >= 300) throw errorOf(reply);
    return reply.json as T;
  }

  return { exchange, json };
}

/** A 2xx body that must be a JSON object. The shape of its fields is the agent's contract, read tolerantly. */
export function expectRecord<T extends object>(value: unknown, what: string): T {
  if (!isRecord(value)) throw new DozeboxError("transport", `${what} response is not an object`, 0, false);
  return value as T;
}
