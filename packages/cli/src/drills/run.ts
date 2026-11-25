// D1: run a drill (teardown always, a missed deadline fails with the step id, refuse over 60% of the test budget
// before step 1) and its JSON report.
import { Type, type Static } from "typebox";
import type { Drill, DrillContext, DrillStep } from "./types.ts";

export const DRILL_BUDGET_SHARE = 0.6;

const MAX_ERROR = 1000;

const StepReport = Type.Object({
  id: Type.String(),
  ok: Type.Boolean(),
  skipped: Type.Optional(Type.Boolean()),
  ms: Type.Number({ minimum: 0 }),
  error: Type.Optional(Type.String({ maxLength: MAX_ERROR })),
});

const OptionsReport = Type.Object({
  withHold: Type.Boolean(),
  extras: Type.Array(Type.String()),
  keep: Type.Boolean(),
  deliver: Type.Union([Type.String(), Type.Null()]),
  broken: Type.Union([Type.String(), Type.Null()]),
});

export const DrillReport = Type.Object({
  v: Type.Literal(1),
  drill: Type.String(),
  runId: Type.String(),
  ok: Type.Boolean(),
  refused: Type.Optional(Type.String()),
  blocked: Type.Optional(Type.String()),
  startedAt: Type.String({ format: "date-time" }),
  finishedAt: Type.String({ format: "date-time" }),
  estimateUsd: Type.Number({ minimum: 0 }),
  monthToDateUsd: Type.Union([Type.Number(), Type.Null()]),
  steps: Type.Array(StepReport),
  teardown: Type.Object({ ok: Type.Boolean(), error: Type.Optional(Type.String({ maxLength: MAX_ERROR })) }),
  facts: Type.Record(Type.String(), Type.Unknown()),
  options: OptionsReport,
});
export type DrillReport = Static<typeof DrillReport>;
type StepResult = Static<typeof StepReport>;

/** Pure: refuse when month-to-date test spend plus the estimate is over the share of the test budget. */
export function budgetGate(i: {
  readonly estimateUsd: number;
  readonly monthToDateUsd: number | null;
  readonly testBudgetUsd: number;
}): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  if (i.monthToDateUsd === null) return { ok: true };
  const limit = DRILL_BUDGET_SHARE * i.testBudgetUsd;
  const total = i.monthToDateUsd + i.estimateUsd;
  if (total <= limit) return { ok: true };
  return {
    ok: false,
    why:
      `month-to-date test spend $${i.monthToDateUsd.toFixed(2)} plus the estimate $${i.estimateUsd.toFixed(2)} ` +
      `is $${total.toFixed(2)}, over ${DRILL_BUDGET_SHARE * 100}% of the $${i.testBudgetUsd.toFixed(2)} test budget ($${limit.toFixed(2)})`,
  };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR);

/** Rejects with the signal's reason as soon as it aborts, so a step that ignores its signal still fails on time. */
function raceAbort(work: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function runStep(step: DrillStep, ctx: DrillContext, outer: AbortSignal | undefined): Promise<StepResult> {
  const clock = ctx.deps.clock;
  const started = clock.now();
  const deadline = clock.timeout(step.deadlineMs);
  const signal = outer === undefined ? deadline : AbortSignal.any([deadline, outer]);
  try {
    await raceAbort((async () => step.run(ctx, signal))(), signal);
    const ms = clock.now() - started;
    ctx.log(`step ${step.id} ok ${(ms / 1000).toFixed(1)} s`);
    return { id: step.id, ok: true, ms };
  } catch (e) {
    const ms = clock.now() - started;
    const error = deadline.aborted
      ? `deadline ${step.deadlineMs / 1000} s missed`
      : outer?.aborted === true
        ? "interrupted"
        : message(e);
    ctx.log(`step ${step.id} FAILED: ${error}`);
    return { id: step.id, ok: false, ms, error };
  }
}

async function runTeardown(drill: Drill, ctx: DrillContext): Promise<DrillReport["teardown"]> {
  try {
    await drill.teardown(ctx);
    ctx.log("teardown ok");
    return { ok: true };
  } catch (e) {
    const error = message(e);
    ctx.log(`teardown FAILED: ${error}`);
    return { ok: false, error };
  }
}

export async function runDrill(
  drill: Drill,
  ctx: DrillContext,
  opts: { readonly testBudgetUsd: number; readonly skip?: ReadonlyArray<string>; readonly signal?: AbortSignal },
): Promise<DrillReport> {
  const clock = ctx.deps.clock;
  const startedAt = new Date(clock.now()).toISOString();
  const finish = (
    part: Pick<DrillReport, "ok" | "estimateUsd" | "monthToDateUsd" | "steps" | "teardown"> &
      Partial<Pick<DrillReport, "refused" | "blocked">>,
  ): DrillReport => ({
    v: 1,
    drill: drill.name,
    runId: ctx.runId,
    startedAt,
    finishedAt: new Date(clock.now()).toISOString(),
    facts: Object.fromEntries(ctx.facts),
    options: { ...ctx.options, extras: [...ctx.options.extras] },
    ...part,
  });
  const noTeardown = { ok: true } as const;

  if (drill.blocked !== undefined) {
    ctx.log(`blocked: ${drill.blocked}`);
    return finish({
      ok: false,
      blocked: drill.blocked,
      estimateUsd: 0,
      monthToDateUsd: null,
      steps: [],
      teardown: noTeardown,
    });
  }

  const estimateUsd = await drill.estimateUsd(ctx);
  const monthToDateUsd = await ctx.deps.aws.testSpendUsd();
  const gate = budgetGate({ estimateUsd, monthToDateUsd, testBudgetUsd: opts.testBudgetUsd });
  if (!gate.ok) {
    ctx.log(`refused: ${gate.why}`);
    return finish({ ok: false, refused: gate.why, estimateUsd, monthToDateUsd, steps: [], teardown: noTeardown });
  }

  const skip = new Set(opts.skip ?? []);
  const steps: StepResult[] = [];
  for (const step of drill.steps) {
    if (step.when !== undefined && !step.when(ctx.options)) continue;
    if (skip.has(step.id)) {
      ctx.log(`step ${step.id} skipped`);
      steps.push({ id: step.id, ok: true, skipped: true, ms: 0 });
      continue;
    }
    const result = await runStep(step, ctx, opts.signal);
    steps.push(result);
    if (!result.ok) break;
  }
  const teardown = await runTeardown(drill, ctx);
  return finish({
    ok: steps.every((s) => s.ok) && teardown.ok,
    estimateUsd,
    monthToDateUsd,
    steps,
    teardown,
  });
}

/** The highest hourly price among `types` in `region`: the drill pays for the worst type it may get. */
export async function estimateHourlyUsd(
  deps: { readonly price: (region: string, type: string) => Promise<number> },
  region: string,
  types: ReadonlyArray<string>,
): Promise<number> {
  const prices = await Promise.all(types.map((t) => deps.price(region, t)));
  return prices.reduce((a, b) => Math.max(a, b), 0);
}
