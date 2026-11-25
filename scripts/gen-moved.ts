// T6: read `terraform state list` of the old root and write `moved` and `removed` blocks for the module.
// Usage: terraform state list | node scripts/gen-moved.ts > moved.tf

export type MovedPlan = {
  readonly moved: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly removed: ReadonlyArray<string>;
  /** Addresses with no rule: the run fails while any are left. */
  readonly unknown: ReadonlyArray<string>;
};

export function planMoves(_stateList: ReadonlyArray<string>): MovedPlan {
  throw new Error("not implemented: T6 planMoves");
}

export function renderMoved(_plan: MovedPlan): string {
  throw new Error("not implemented: T6 renderMoved");
}
