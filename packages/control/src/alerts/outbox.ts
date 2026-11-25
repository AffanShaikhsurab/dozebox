// C2: the transactional outbox for alerts (part 6 §6.3): one item per (alert, sink), written `pending` before any
// delivery, marked `sent` after, retried by every tick with backoff, `failed` after 24 h.
import type { Clock } from "@dozebox/core/time";
import type { Alert } from "../ports/alertSink.ts";
import type { StateTable } from "../ports/state.ts";

export type OutboxStatus = "pending" | "sent" | "failed";

export type OutboxItem = {
  readonly alertId: string;
  readonly sink: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly alert: Alert;
};

/** Retry delays 1, 2, 4, 8 min, then every 15 min, each with +-20% jitter from `rand` (0 to 1). */
export function nextAttempt(_attempts: number, _now: number, _rand: () => number): number {
  throw new Error("not implemented: C2 nextAttempt");
}

export interface Outbox {
  /** Write one `pending` item per sink; an item that already exists for (alert, sink) is left as it is. */
  readonly enqueue: (alert: Alert, sinks: ReadonlyArray<string>, token: number) => Promise<void>;
  /** `pending` items with `nextAttemptAt <= now`, oldest first. */
  readonly due: (now: number) => Promise<ReadonlyArray<OutboxItem>>;
  readonly markSent: (item: OutboxItem, token: number) => Promise<void>;
  /** Count one failed attempt: reschedule, or `failed` after 24 h. Returns the stored item. */
  readonly markAttempt: (item: OutboxItem, reason: string, token: number) => Promise<OutboxItem>;
}

export function makeOutbox(_deps: {
  readonly state: StateTable;
  readonly clock: Pick<Clock, "now">;
  readonly rand: () => number;
}): Outbox {
  throw new Error("not implemented: C2 makeOutbox");
}
