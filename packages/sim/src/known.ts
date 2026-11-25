// S1: the known simulator classes (SIM ids, part 9) with their census ceilings, and the judge `pnpm sim:judge` runs.
import type { Census, SimClassId } from "./run.ts";

export type KnownClass = {
  readonly id: SimClassId;
  readonly name: string;
  /** Most seeds out of 5,000 allowed to show it; 0 once fixed. */
  readonly ceiling: number;
};

export type JudgeResult = {
  readonly ok: boolean;
  readonly over: ReadonlyArray<{ readonly id: string; readonly seen: number; readonly ceiling: number }>;
};

export function knownClasses(): ReadonlyArray<KnownClass> {
  throw new Error("not implemented: S1 knownClasses");
}

/** Every class at or under its ceiling, and no unknown class. */
export function judgeCensus(_census: Census, _known: ReadonlyArray<KnownClass>): JudgeResult {
  throw new Error("not implemented: S1 judgeCensus");
}
