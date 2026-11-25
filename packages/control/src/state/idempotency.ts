// C2: idempotency keys (part 6 §6.3) in the state table, kept 24 h. `makeStateIdempotency<FunctionUrlResult>(state,
// "wake")` is the value C1's `Deps.idempotency` (`WakeIdempotency`) takes; hook delivery ids use scope `hook:<id>`.
// An entry is written once (putIfAbsent), so a repeat of the same key keeps the first answer.
import { createHash } from "node:crypto";
import type { StateTable } from "../ports/state.ts";

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface StateIdempotency<T> {
  /** The first answer stored for `key`, or null. */
  readonly recall: (key: string) => Promise<T | null>;
  /** Store the answer; a second remember of the same key keeps the first. */
  readonly remember: (key: string, answer: T) => Promise<void>;
}

type Entry = { readonly v: 1; readonly answer: unknown };

const isEntry = (x: unknown): x is Entry =>
  typeof x === "object" && x !== null && (x as { readonly v?: unknown }).v === 1 && "answer" in x;

export function makeStateIdempotency<T>(
  state: StateTable,
  scope: string,
  ttlSeconds: number = IDEMPOTENCY_TTL_SECONDS,
): StateIdempotency<T> {
  const key = (k: string): string => `idem#${scope}#${k}`;
  return {
    recall: async (k) => {
      const stored = await state.get(key(k));
      // Only this module writes `idem#` keys, always as an Entry of T.
      return isEntry(stored) ? (stored.answer as T) : null;
    },
    remember: async (k, answer) => {
      const entry: Entry = { v: 1, answer };
      await state.putIfAbsent(key(k), entry, ttlSeconds);
    },
  };
}

/**
 * EC2 and group action tokens: `sha256(box, intentId, attempt)` cut to 64 characters, never a clock value. The
 * intent id is the desired state's fence (`desiredOrder` in C1's `state/keys.ts`) as a string.
 */
export function actionToken(box: string, intentId: string, attempt: number): string {
  return createHash("sha256").update(`${box}\n${intentId}\n${attempt}`, "utf8").digest("hex").slice(0, 64);
}
