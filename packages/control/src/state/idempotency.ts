// C2: idempotency keys (part 6 §6.3) in the state table, kept 24 h. `makeStateIdempotency<FunctionUrlResult>(state,
// "wake")` is the value C1's `Deps.idempotency` (`WakeIdempotency`) takes; hook delivery ids use scope `hook:<id>`.
import type { StateTable } from "../ports/state.ts";

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface StateIdempotency<T> {
  /** The first answer stored for `key`, or null. */
  readonly recall: (key: string) => Promise<T | null>;
  /** Store the answer; a second remember of the same key keeps the first. */
  readonly remember: (key: string, answer: T) => Promise<void>;
}

export function makeStateIdempotency<T>(
  _state: StateTable,
  _scope: string,
  _ttlSeconds: number = IDEMPOTENCY_TTL_SECONDS,
): StateIdempotency<T> {
  throw new Error("not implemented: C2 makeStateIdempotency");
}

/**
 * EC2 and group action tokens: `sha256(box, intentId, attempt)` cut to 64 characters, never a clock value. The
 * intent id is the desired state's fence (`desiredOrder` in C1's `state/keys.ts`) as a string.
 */
export function actionToken(_box: string, _intentId: string, _attempt: number): string {
  throw new Error("not implemented: C2 actionToken");
}
