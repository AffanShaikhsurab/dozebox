// What a wake request does (part 13 WP-K3). The wake route never calls EC2 (SIM-F5, R1): it records desired = awake and
// the tick acts. A person's wake passes the breaker; the budget and the freeze hold for everyone.
import type { Desired } from "../reconcile/decide.ts";
import { DAY, HOUR } from "../time/index.ts";
import { breakerOpen, type WakeBreaker } from "./budget.ts";

export type WakeOrigin = "person" | "schedule" | "event";
export type WakeInput = {
  readonly now: number;
  readonly origin: WakeOrigin;
  readonly desired: Desired;
  readonly frozen: boolean;
  readonly budget: {
    readonly lastHour: number;
    readonly lastDay: number;
    readonly perHour: number;
    readonly perDay: number;
  };
  /** The wake breaker (part 6 §6.3); absent means closed. */
  readonly breaker?: WakeBreaker;
};
export type WakeDecision =
  | { readonly kind: "accept"; readonly desired: Desired }
  | { readonly kind: "already-awake" }
  | { readonly kind: "refuse"; readonly code: "frozen" | "budget" | "breaker"; readonly retryAfterMs?: number };

export function decideWake(i: WakeInput): WakeDecision {
  if (i.frozen) return { kind: "refuse", code: "frozen" };
  if (i.desired.want === "awake") return { kind: "already-awake" };
  if (i.budget.lastHour >= i.budget.perHour) return { kind: "refuse", code: "budget", retryAfterMs: HOUR };
  if (i.budget.lastDay >= i.budget.perDay) return { kind: "refuse", code: "budget", retryAfterMs: DAY };
  if (i.origin !== "person" && i.breaker !== undefined && breakerOpen(i.breaker, i.now)) {
    const openedAt = i.breaker.openedAt ?? i.now;
    return { kind: "refuse", code: "breaker", retryAfterMs: Math.max(0, openedAt + i.breaker.coolMs - i.now) };
  }
  return {
    kind: "accept",
    desired: {
      want: "awake",
      since: i.now,
      reason: `wake:${i.origin}`,
      origin: i.origin === "person" ? "user" : i.origin,
    },
  };
}

/** A park request: always accepted, and always written, even when nothing runs (R2, SIM-F8). */
export function decidePark(now: number, origin: Desired["origin"], reason: string): Desired {
  return { want: "asleep", since: now, reason: `park:${reason}`, origin };
}
