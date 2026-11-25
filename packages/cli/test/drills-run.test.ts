import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeAutoClock, makeFakeCliDeps, stackOutputsFixture, controlStatusFixture } from "@dozebox/testkit/fakes";
import { Value } from "typebox/value";
import { budgetGate, DrillReport, estimateHourlyUsd, runDrill } from "../src/drills/run.ts";
import type { Drill, DrillContext, DrillOptions, DrillStep } from "../src/drills/types.ts";

const OPTIONS: DrillOptions = { withHold: false, extras: [], keep: false, deliver: null, broken: null };

function setup(options: DrillOptions = OPTIONS) {
  const deps = makeFakeCliDeps({
    status: controlStatusFixture(),
    outputs: stackOutputsFixture(),
    clock: makeAutoClock(),
  });
  const logs: string[] = [];
  const ctx: DrillContext = {
    runId: "t-20261125000000",
    stackDir: "./.dozebox",
    nonce: "n",
    log: (l) => logs.push(l),
    stack: () => Promise.reject(new Error("unused")),
    deps,
    options,
    cli: () => Promise.reject(new Error("unused")),
    facts: new Map(),
  };
  return { deps, ctx, logs };
}

const step = (id: string, run: DrillStep["run"] = async () => {}, extra: Partial<DrillStep> = {}): DrillStep => ({
  id,
  deadlineMs: 60_000,
  run,
  ...extra,
});

function drillOf(steps: ReadonlyArray<DrillStep>, over: Partial<Drill> & { readonly torn?: string[] } = {}): Drill {
  const { torn, ...rest } = over;
  return {
    name: "t",
    estimateUsd: async () => 1,
    steps,
    teardown: async () => void torn?.push("teardown"),
    ...rest,
  };
}

const BUDGET = { testBudgetUsd: 10 };

describe("budgetGate", () => {
  it("allows up to 60% of the budget and names the numbers when refusing", () => {
    assert.deepEqual(budgetGate({ estimateUsd: 1, monthToDateUsd: 5, testBudgetUsd: 10 }), { ok: true });
    const refused = budgetGate({ estimateUsd: 1.5, monthToDateUsd: 5, testBudgetUsd: 10 });
    assert.equal(refused.ok, false);
    if (!refused.ok) for (const n of ["5.00", "1.50", "6.50", "60%", "10.00"]) assert.ok(refused.why.includes(n), n);
  });
  it("runs when Cost Explorer has no data", () => {
    assert.deepEqual(budgetGate({ estimateUsd: 100, monthToDateUsd: null, testBudgetUsd: 10 }), { ok: true });
  });
});

describe("runDrill", () => {
  it("runs the steps in order, then the teardown, and the report matches the schema", async () => {
    const { ctx } = setup();
    const seen: string[] = [];
    ctx.facts.set("volume", "vol-1");
    const report = await runDrill(
      drillOf([step("a", async () => void seen.push("a")), step("b", async () => void seen.push("b"))], { torn: seen }),
      ctx,
      BUDGET,
    );
    assert.deepEqual(seen, ["a", "b", "teardown"]);
    assert.equal(report.ok, true);
    assert.equal(report.estimateUsd, 1);
    assert.equal(report.monthToDateUsd, 0);
    assert.deepEqual(report.facts, { volume: "vol-1" });
    assert.equal(Value.Check(DrillReport, report), true, JSON.stringify([...Value.Errors(DrillReport, report)]));
  });

  it("a failing step stops the rest and still runs the teardown", async () => {
    const { ctx, logs } = setup();
    const seen: string[] = [];
    const report = await runDrill(
      drillOf(
        [
          step("a", async () => {
            throw new Error("x".repeat(2000));
          }),
          step("b", async () => void seen.push("b")),
        ],
        { torn: seen },
      ),
      ctx,
      BUDGET,
    );
    assert.deepEqual(seen, ["teardown"]);
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.steps.map((s) => [s.id, s.ok]),
      [["a", false]],
    );
    assert.equal(report.steps[0]?.error?.length, 1000);
    assert.equal(Value.Check(DrillReport, report), true);
    assert.ok(logs.some((l) => l.startsWith("step a FAILED: ")));
  });

  it("a missed deadline fails the step by id and runs the teardown", async () => {
    const { ctx } = setup();
    const seen: string[] = [];
    const slow = step("slow", (c, signal) => c.deps.clock.sleep(10_000, signal), { deadlineMs: 5_000 });
    const report = await runDrill(drillOf([slow, step("after")], { torn: seen }), ctx, BUDGET);
    assert.deepEqual(seen, ["teardown"]);
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.steps.map((s) => [s.id, s.ok, s.error]),
      [["slow", false, "deadline 5 s missed"]],
    );
  });

  it("the drill's own abort signal stops a step", async () => {
    const { ctx } = setup();
    const c = new AbortController();
    const s = step("wait", async (x, signal) => {
      c.abort();
      await x.deps.clock.sleep(1, signal);
    });
    const report = await runDrill(drillOf([s]), ctx, { ...BUDGET, signal: c.signal });
    assert.equal(report.ok, false);
    assert.equal(report.steps[0]?.error, "interrupted");
  });

  it("refuses over 60% of the test budget before step 1: no step, no teardown", async () => {
    const { ctx, deps } = setup();
    deps.aws.spendUsd = 5.5;
    const seen: string[] = [];
    const report = await runDrill(drillOf([step("a", async () => void seen.push("a"))], { torn: seen }), ctx, BUDGET);
    assert.deepEqual(seen, []);
    assert.equal(report.ok, false);
    assert.match(report.refused ?? "", /5\.50/);
    assert.equal(report.monthToDateUsd, 5.5);
    assert.deepEqual(report.steps, []);
    assert.equal(Value.Check(DrillReport, report), true);
  });

  it("runs when the spend is unknown", async () => {
    const { ctx, deps } = setup();
    deps.aws.spendUsd = null;
    const report = await runDrill(drillOf([step("a")]), ctx, BUDGET);
    assert.equal(report.ok, true);
    assert.equal(report.monthToDateUsd, null);
    assert.equal(Value.Check(DrillReport, report), true);
  });

  it("skips named steps and steps whose `when` is false", async () => {
    const { ctx } = setup();
    const seen: string[] = [];
    const report = await runDrill(
      drillOf([
        step("a", async () => void seen.push("a")),
        step("hold", async () => void seen.push("hold"), { when: (o) => o.withHold }),
        step("c", async () => void seen.push("c")),
      ]),
      ctx,
      { ...BUDGET, skip: ["a"] },
    );
    assert.deepEqual(seen, ["c"]);
    assert.deepEqual(report.steps, [
      { id: "a", ok: true, skipped: true, ms: 0 },
      { id: "c", ok: true, ms: 0 },
    ]);
    assert.equal(Value.Check(DrillReport, report), true);
  });

  it("a blocked drill reports why and runs nothing", async () => {
    const { ctx } = setup();
    const seen: string[] = [];
    const report = await runDrill(
      drillOf([step("a", async () => void seen.push("a"))], { blocked: "no FIS", torn: seen }),
      ctx,
      BUDGET,
    );
    assert.deepEqual(seen, []);
    assert.equal(report.ok, false);
    assert.equal(report.blocked, "no FIS");
    assert.deepEqual(report.steps, []);
    assert.equal(Value.Check(DrillReport, report), true);
  });

  it("records a teardown error and fails the drill after passing steps", async () => {
    const { ctx } = setup();
    const report = await runDrill(
      drillOf([step("a")], {
        teardown: async () => {
          throw new Error("destroy failed");
        },
      }),
      ctx,
      BUDGET,
    );
    assert.equal(report.ok, false);
    assert.deepEqual(report.teardown, { ok: false, error: "destroy failed" });
    assert.equal(report.steps[0]?.ok, true);
  });
});

describe("estimateHourlyUsd", () => {
  it("is the highest price among the types", async () => {
    const prices: Record<string, number> = { "t4g.small": 0.0168, "t4g.large": 0.0672, "t4g.medium": 0.0336 };
    const usd = await estimateHourlyUsd({ price: async (_r, t) => prices[t] ?? 0 }, "us-east-1", Object.keys(prices));
    assert.equal(usd, 0.0672);
    assert.equal(await estimateHourlyUsd({ price: async () => 1 }, "us-east-1", []), 0);
  });
});
