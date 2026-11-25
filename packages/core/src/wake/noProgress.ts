// The no-progress park (legacy LJ2, part 4 §4.6 and §4.7): a serving box with no progress beat, no live work hold and
// no interactive presence for `noProgressParkMinutes` is parked with reason `no-progress`. A `wait` hold keeps the box
// awake for the idle verdict but does not stop this clock.

export type NoProgressInput = {
  readonly now: number;
  readonly noProgressMs: number;
  readonly servingSince: number | null;
  readonly lastProgressAt: number | null;
  /** A live `work` hold. */
  readonly workHold: boolean;
  /** Live interactive presence (a person is using the box). */
  readonly interactive: boolean;
};

export type NoProgressDecision =
  | { readonly kind: "not-serving" }
  | { readonly kind: "progressing"; readonly parkAt: number | null }
  | { readonly kind: "park"; readonly quietSince: number };

export function decideNoProgress(i: NoProgressInput): NoProgressDecision {
  if (i.servingSince === null) return { kind: "not-serving" };
  if (i.workHold || i.interactive) return { kind: "progressing", parkAt: null };
  const quietSince = Math.max(i.servingSince, i.lastProgressAt ?? 0);
  const parkAt = quietSince + i.noProgressMs;
  return i.now >= parkAt ? { kind: "park", quietSince } : { kind: "progressing", parkAt };
}
