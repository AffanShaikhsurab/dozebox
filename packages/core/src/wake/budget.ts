// The wake budget (6 an hour, 24 a day) and the wake breaker (part 6 §6.3, legacy LJ1): after 3 wakes in a row that
// end unresolved or with a failed boot, unattended wakes are refused for 6 hours and a page goes out. A person's wake
// always gets through, and resets the breaker when it serves.
import { DAY, HOUR } from "../time/index.ts";

export const WAKE_BUDGET = { perHour: 6, perDay: 24 } as const;

/** Accepted wakes in the last hour and day, from their accept times (ms). */
export function countWakes(acceptedAt: ReadonlyArray<number>, now: number): { lastHour: number; lastDay: number } {
  let lastHour = 0;
  let lastDay = 0;
  for (const t of acceptedAt) {
    const age = now - t;
    if (age < 0 || age >= DAY) continue;
    lastDay += 1;
    if (age < HOUR) lastHour += 1;
  }
  return { lastHour, lastDay };
}

export type WakeBreaker = {
  readonly failuresInRow: number;
  readonly openedAt: number | null;
  readonly threshold: number;
  readonly coolMs: number;
};

export const NEW_WAKE_BREAKER: WakeBreaker = { failuresInRow: 0, openedAt: null, threshold: 3, coolMs: 6 * HOUR };

export function breakerOpen(b: WakeBreaker, now: number): boolean {
  return b.openedAt !== null && now - b.openedAt < b.coolMs;
}

export type WakeEnd = "served" | "unresolved" | "boot-failed";

/** The breaker after one wake ended; `page` is true when this end opened it. */
export function onWakeEnd(b: WakeBreaker, end: WakeEnd, now: number): { breaker: WakeBreaker; page: boolean } {
  if (end === "served") return { breaker: { ...b, failuresInRow: 0, openedAt: null }, page: false };
  const failuresInRow = b.failuresInRow + 1;
  if (failuresInRow >= b.threshold && !breakerOpen(b, now)) {
    return { breaker: { ...b, failuresInRow, openedAt: now }, page: true };
  }
  return { breaker: { ...b, failuresInRow }, page: false };
}
