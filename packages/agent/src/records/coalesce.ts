// A7: coalescing in front of A1's RecordPublisher: `rec/liveness` within 10 s of a change and at least every 5 min;
// one write in flight per record; throttled writes back off (full jitter) without losing the newest body.
import type { Clock } from "@dozebox/core/time";
import type { RecordName, RecordTypes } from "@dozebox/core/records";
import type { RecordPublisher } from "./publish.ts";

export const LIVENESS_CHANGE_MS = 10_000;
export const LIVENESS_EVERY_MS = 5 * 60_000;

export interface CoalescingPublisher {
  /** Remember the newest body for `name`; it is written within `LIVENESS_CHANGE_MS` when it differs. */
  readonly offer: <N extends RecordName>(name: N, body: Omit<RecordTypes[N], "v" | "at" | "writer">) => void;
  /** Write everything pending now (park calls it before last words). */
  readonly flush: (signal: AbortSignal) => Promise<void>;
}

export function makeCoalescingPublisher(_deps: {
  readonly publisher: RecordPublisher;
  readonly clock: Clock;
  readonly rand: () => number;
}): CoalescingPublisher {
  throw new Error("not implemented: A7 makeCoalescingPublisher");
}
