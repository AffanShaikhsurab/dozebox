// D1: run a drill (teardown always, a missed deadline fails with the step id, refuse over 60% of the test budget
// before step 1) and its JSON report.
import { Type, type Static } from "typebox";
import type { Drill, DrillContext } from "./types.ts";

export const DRILL_BUDGET_SHARE = 0.6;

const StepReport = Type.Object({
  id: Type.String(),
  ok: Type.Boolean(),
  ms: Type.Number({ minimum: 0 }),
  error: Type.Optional(Type.String({ maxLength: 1000 })),
});

export const DrillReport = Type.Object({
  v: Type.Literal(1),
  drill: Type.String(),
  runId: Type.String(),
  ok: Type.Boolean(),
  refused: Type.Optional(Type.String()),
  startedAt: Type.String({ format: "date-time" }),
  finishedAt: Type.String({ format: "date-time" }),
  estimateUsd: Type.Number({ minimum: 0 }),
  steps: Type.Array(StepReport),
  teardown: Type.Object({ ok: Type.Boolean(), error: Type.Optional(Type.String({ maxLength: 1000 })) }),
});
export type DrillReport = Static<typeof DrillReport>;

/** Pure: refuse when month-to-date test spend plus the estimate is over the share of the test budget. */
export function budgetGate(_i: {
  readonly estimateUsd: number;
  readonly monthToDateUsd: number | null;
  readonly testBudgetUsd: number;
}): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  throw new Error("not implemented: D1 budgetGate");
}

export function runDrill(
  _drill: Drill,
  _ctx: DrillContext,
  _opts: { readonly testBudgetUsd: number; readonly skip?: ReadonlyArray<string> },
): Promise<DrillReport> {
  throw new Error("not implemented: D1 runDrill");
}

/** Price per hour for `types` in `region` from the Price List API, cached per day. */
export function estimateHourlyUsd(
  _deps: { readonly price: (region: string, type: string) => Promise<number> },
  _region: string,
  _types: ReadonlyArray<string>,
): Promise<number> {
  throw new Error("not implemented: D1 estimateHourlyUsd");
}
