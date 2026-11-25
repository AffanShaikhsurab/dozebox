// Intent freshness under R2 (part 9 §9.1): a wake intent older than the newest `asleep` is void, whatever EC2 shows.
// EC2 words a stop to the second, so a wake in the same second as a stop it cannot be ordered against loses.
import type { Desired } from "../reconcile/decide.ts";
import { MINUTE } from "../time/index.ts";

/** A wake intent the shell retries on its own (the legacy 5-minute rule); the typed tick reads `desired` instead. */
export const INTENT_FRESH_MS = 5 * MINUTE;

export type IntentFacts = {
  readonly now: number;
  /** When the wake was accepted. */
  readonly at: number;
  /** The newest park request, written by every park even when it stopped nothing (SIM-F8). */
  readonly newestAsleepAt: number | null;
  /** When EC2 says the instance stopped, to the second, or null. */
  readonly stoppedAt: number | null;
  readonly freshMs?: number;
};

/** True while the wake intent still asks for a start: younger than `freshMs` and newer than every sleep and stop. */
export function intentFresh(i: IntentFacts): boolean {
  if (i.now - i.at >= (i.freshMs ?? INTENT_FRESH_MS)) return false;
  return !intentVoid(i);
}

/** True when a park or stop came after the wake intent (R2). */
export function intentVoid(i: Pick<IntentFacts, "at" | "newestAsleepAt" | "stoppedAt">): boolean {
  const stoppedEnd = i.stoppedAt === null ? null : i.stoppedAt + 999;
  const down = Math.max(stoppedEnd ?? 0, i.newestAsleepAt ?? 0);
  return down !== 0 && i.at <= down;
}

/** The desired state that holds: the newest one written. Ties go to `asleep` (a sleep wins its own second). */
export function newestDesired(list: ReadonlyArray<Desired>): Desired | null {
  let best: Desired | null = null;
  for (const d of list) {
    if (best === null || d.since > best.since || (d.since === best.since && d.want === "asleep")) best = d;
  }
  return best;
}
