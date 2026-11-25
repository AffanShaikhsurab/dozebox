// The sink breaker (part 6 §6.3): a sink that fails 5 deliveries in a row is skipped for 15 minutes, then tried once
// (half-open). Pure state transitions; the outbox shell keeps one per sink.
import { MINUTE } from "../time/index.ts";

export type Breaker = {
  readonly state: "closed" | "open" | "half-open";
  readonly failures: number;
  readonly openedAt: number | null;
};

export const CLOSED: Breaker = { state: "closed", failures: 0, openedAt: null };
export const SINK_FAILURE_THRESHOLD = 5;
export const SINK_COOL_MS = 15 * MINUTE;

export function onResult(b: Breaker, ok: boolean, now: number, threshold = SINK_FAILURE_THRESHOLD): Breaker {
  if (ok) return CLOSED;
  const failures = b.failures + 1;
  if (b.state === "half-open" || failures >= threshold) return { state: "open", failures, openedAt: now };
  return { state: "closed", failures, openedAt: null };
}

/** The breaker to deliver through, or null when the sink is skipped. An open breaker turns half-open after the cool time. */
export function allow(b: Breaker, now: number, coolMs = SINK_COOL_MS): Breaker | null {
  if (b.state !== "open") return b;
  return b.openedAt !== null && now - b.openedAt >= coolMs ? { ...b, state: "half-open" } : null;
}
