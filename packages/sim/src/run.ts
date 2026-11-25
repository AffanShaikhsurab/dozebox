// S1: the simulator, ported from legacy/runner/test/sim/*.mjs and wired to @dozebox/core (the same decision
// functions production runs). Seeded and deterministic: one seed is one simulated box over `days`.
export type SimClassId = `SIM-F${number}`;

export type SimOptions = {
  readonly days?: number;
  /** Fault mix, such as stale describes, Spot interruptions, lost events. Default: the legacy mix. */
  readonly faults?: Readonly<Record<string, number>>;
  /** The agent model: `protocol` (S2) or `health-only`. */
  readonly agent?: "protocol" | "health-only";
};

export type SimFinding = { readonly cls: SimClassId | "unknown"; readonly at: number; readonly detail: string };

export type SimRun = {
  readonly seed: number;
  readonly findings: ReadonlyArray<SimFinding>;
  readonly awakeMs: number;
  readonly wakes: number;
};

export type Census = {
  readonly seeds: number;
  /** Seeds with at least one finding of each class. */
  readonly byClass: Readonly<Record<string, number>>;
};

export function runSeed(_seed: number, _opts?: SimOptions): SimRun {
  throw new Error("not implemented: S1 runSeed");
}

export function runCensus(_seeds: ReadonlyArray<number>, _opts?: SimOptions): Census {
  throw new Error("not implemented: S1 runCensus");
}
