// S1: the classes the simulator may still find (SIM ids, part 9 §9.3), each with its rate per 100,000 seeds, a
// replaying seed and an owner, and the judge `pnpm sim:judge` runs. A class is the exact rule string, decided from
// the world's truth, so an entry never covers another cause. Closing a class removes it here and keeps its seed as a
// named regression scenario (test/scenarios.test.ts).
import type { Census, SimClassId } from "./run.ts";

export type KnownClass = {
  readonly id: SimClassId;
  /** The rule string, such as `wake-unresolved/no-instance`. */
  readonly name: string;
  /** Most seeds out of 5,000 allowed to show it; 0 once fixed. */
  readonly ceiling: number;
  /** Measured seeds per 100,000; the ceiling for another seed count follows from it. */
  readonly rate: number;
  readonly seed: number;
  readonly owner: string;
};

export type JudgeResult = {
  readonly ok: boolean;
  readonly over: ReadonlyArray<{ readonly id: string; readonly seen: number; readonly ceiling: number }>;
};

/** 1.5 times the recorded rate plus Poisson slack (part 9 §9.3): `ceil(1.5e + 3√e) + 1`, `e = rate × seeds / 100,000`. */
export function ceilingFor(rate: number, seeds: number): number {
  const e = (rate * seeds) / 100_000;
  return Math.ceil(1.5 * e + 3 * Math.sqrt(e)) + 1;
}

const known = (id: SimClassId, name: string, rate: number, seed: number, owner: string): KnownClass => ({
  id,
  name,
  rate,
  seed,
  owner,
  ceiling: ceilingFor(rate, 5000),
});

// Measured on the TypeScript simulator, seeds 1-100,000 (2026-11-25). The legacy classes SIM-F1, F3, F4, F5, F8 stay
// closed (R1, R2), SIM-F12 and F15 do not occur (their regression scenarios are in test/scenarios.test.ts), and R3
// (the judge in the simulated tick) closes most of SIM-F7.
const CLASSES: ReadonlyArray<KnownClass> = [
  known(
    "SIM-F2",
    "sleep-undone/raced-with-sleep",
    36,
    2936,
    "control (C3 act): a park lands between the tick's last re-read and its StartInstances or SetDesiredCapacity; the next tick parks again within a minute",
  ),
  known(
    "SIM-F16",
    "recovery-loop/other",
    10,
    4757,
    "control (C3 act): the reverse race; a wake lands between the re-read and a park's StopInstances, so the tick stops, then starts again",
  ),
  known(
    "SIM-F17",
    "park-during-handoff",
    4,
    18384,
    "core reconcile (K3) + C3: right after our own StartInstances a stale describe shows `stopped` with the Spot request `active`, read as a refused start, so a fallback is raised; when the warning is lost the loser is lowered during the hand-off. Needs the last start time in Observed",
  ),
  known(
    "SIM-F10",
    "recovery-loop/handoff-park",
    4,
    63218,
    "core reconcile (K3): same root as SIM-F17; the loser group is lowered during a hand-off and the persistent instance is restarted after EC2 stopped it",
  ),
  known(
    "SIM-F7",
    "wake-unresolved/boot-killed/replacement-after-serve",
    1,
    66751,
    "control (C6 judge): a replacement killed mid-boot after a serve; the judge's 12-minute report misses the invariant's 15 minutes when ticks are dropped",
  ),
];

export function knownClasses(): ReadonlyArray<KnownClass> {
  return CLASSES;
}

/** Every class at or under its ceiling for the census's seed count, no unknown class, and no model error. */
export function judgeCensus(census: Census, classes: ReadonlyArray<KnownClass>): JudgeResult {
  const over: Array<{ id: string; seen: number; ceiling: number }> = [];
  for (const [name, seen] of Object.entries(census.byClass)) {
    const k = classes.find((c) => c.name === name);
    const ceiling = k === undefined ? 0 : ceilingFor(k.rate, census.seeds);
    if (seen > ceiling) over.push({ id: k === undefined ? name : `${k.id} ${name}`, seen, ceiling });
  }
  if (census.modelErrors > 0) over.push({ id: "model-error", seen: census.modelErrors, ceiling: 0 });
  return { ok: over.length === 0, over };
}
