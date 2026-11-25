// Rows ported from legacy/runner/test/control/caps.node-test.ts (the pure rules; the full legacy file runs against
// these modules through legacy/runner/control/core.mjs), and the new counting from EC2 state history and spend.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  AWAKE_CAP_DEFAULTS,
  decideAwakeCap,
  parseCapConfig,
  sumMinutes,
  unattendedDeadlineMs,
  unattendedMayUseOnDemand,
  wakesAtFor,
  type CapConfig,
} from "../src/caps/awake.ts";
import { countAwake, runningIntervals, unionMs } from "../src/caps/history.ts";
import { judgeSpend } from "../src/caps/spend.ts";

const T0 = Date.parse("2026-11-24T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const cfg = parseCapConfig("{}") as CapConfig;
const iso = (ms: number) => new Date(ms).toISOString();

test("parseCapConfig: off when unset, defaults for junk, warn and rewake under park, null switches On-Demand off", () => {
  assert.equal(parseCapConfig(""), null);
  assert.equal(parseCapConfig(undefined), null);
  assert.deepEqual(parseCapConfig("not json"), { ...AWAKE_CAP_DEFAULTS });
  assert.deepEqual(parseCapConfig('{"parkMinutes":600,"warnMinutes":900,"rewakeMinutes":-1}'), {
    ...AWAKE_CAP_DEFAULTS,
    parkMinutes: 600,
    warnMinutes: 600,
    rewakeMinutes: 600,
    overrideMinutes: 1200,
  });
  assert.equal(parseCapConfig('{"onDemandMinutes":null}')?.onDemandMinutes, null);
});

const rows: ReadonlyArray<{ name: string; input: Partial<Parameters<typeof decideAwakeCap>[0]>; expect: unknown }> = [
  { name: "under every limit: nothing", input: { awakeMinutes: 60 }, expect: null },
  {
    name: "a freeze parks and blocks wakes",
    input: { awakeMinutes: 0, frozen: { budget: "monthly" } },
    expect: { rule: "frozen", park: true, blocksWake: true },
  },
  {
    name: "a kill-switch alarm in ALARM parks",
    input: { awakeMinutes: 0, alarms: [{ name: "box-awake-sum", state: "ALARM" }] },
    expect: { rule: "native", park: true, blocksWake: true },
  },
  {
    name: "16 h in 24 parks",
    input: { awakeMinutes: 16 * 60 },
    expect: { rule: "awake-24h", park: true, blocksWake: true },
  },
  {
    name: "14 h in 24 warns",
    input: { awakeMinutes: 14 * 60 },
    expect: { rule: "awake-24h", park: false, blocksWake: false },
  },
  {
    name: "held by the cap until under the rewake line",
    input: { awakeMinutes: 13 * 60, held: { rule: "awake-24h", blocksWake: true } },
    expect: { rule: "awake-24h", park: true, blocksWake: true },
  },
  {
    name: "an override raises the park line",
    input: { awakeMinutes: 19 * 60, override: { at: null, until: iso(T0 + HOUR), by: "me" } },
    expect: { rule: "awake-24h", park: false, blocksWake: false },
  },
  {
    name: "18 h since the wake parks (per-wake), without blocking the next wake",
    input: { awakeMinutes: 60, running: [{ state: "running", launchedAt: iso(T0 - 18 * HOUR) }] },
    expect: { rule: "per-wake", park: true, blocksWake: false },
  },
  {
    name: "On-Demand over its 3 h parks an On-Demand machine",
    input: {
      awakeMinutes: 60,
      onDemandMinutes: 180,
      running: [{ state: "running", launchedAt: iso(T0 - HOUR), lifecycle: "on-demand" }],
    },
    expect: { rule: "on-demand-hours", park: true, blocksWake: false },
  },
  {
    name: "On-Demand over its 3 h on Spot: Spot only from now on",
    input: {
      awakeMinutes: 60,
      onDemandMinutes: 180,
      running: [{ state: "running", launchedAt: iso(T0 - HOUR), lifecycle: "spot" }],
    },
    expect: { rule: "on-demand-hours", park: false, blocksWake: false },
  },
];

for (const row of rows) {
  test(`decideAwakeCap: ${row.name}`, () => {
    const v = decideAwakeCap({ awakeMinutes: 0, cfg, nowMs: T0, ...row.input });
    if (row.expect === null) return assert.equal(v, null);
    const { rule, park, blocksWake } = v ?? { rule: null, park: null, blocksWake: null };
    assert.deepEqual({ rule, park, blocksWake }, row.expect);
  });
}

test("Budgets data null -> no freeze, caps still enforced", () => {
  const spend = judgeSpend(null, { monthlyBudgetUsd: 25 });
  assert.deepEqual(spend, { level: "unknown", freeze: false, percent: null });
  const v = decideAwakeCap({ awakeMinutes: 16 * 60, frozen: spend.freeze ? spend : null, cfg, nowMs: T0 });
  assert.equal(v?.rule, "awake-24h");
  assert.equal(v?.park, true);
});

test("judgeSpend: freeze at the budget, warn at 80%, ok below", () => {
  assert.equal(judgeSpend({ usd: 25, asOf: T0 }, { monthlyBudgetUsd: 25 }).level, "freeze");
  assert.equal(judgeSpend({ usd: 20, asOf: T0 }, { monthlyBudgetUsd: 25 }).level, "warn");
  assert.equal(judgeSpend({ usd: 3, asOf: T0 }, { monthlyBudgetUsd: 25 }).level, "ok");
  assert.equal(judgeSpend({ usd: 15, asOf: T0 }, { monthlyBudgetUsd: 25, freezeAtPercent: 60 }).freeze, true);
  assert.equal(judgeSpend({ usd: 5, asOf: T0 }, { monthlyBudgetUsd: 0 }).level, "unknown");
});

test("sumMinutes caps a bucket at 60 however many targets ran; wakesAtFor waits for old hours to leave", () => {
  const { minutes, buckets } = sumMinutes([
    [
      { at: T0 - 2 * HOUR, value: 60 },
      { at: T0 - HOUR, value: 30 },
    ],
    [
      { at: T0 - 2 * HOUR, value: 20 },
      { at: T0 - HOUR, value: "x" },
    ],
  ]);
  assert.equal(minutes, 90);
  assert.equal(wakesAtFor(buckets, { rewakeMinutes: 100, nowMs: T0 }), T0);
  assert.equal(wakesAtFor(buckets, { rewakeMinutes: 30, nowMs: T0 }), T0 - 2 * HOUR + HOUR + 24 * HOUR);
  assert.equal(wakesAtFor([], { rewakeMinutes: -1, nowMs: T0 }), null);
});

test("the unattended deadline: 07:00 next morning after 18:00, else 2 h after the first refusal", () => {
  const evening = Date.parse("2026-11-24T19:00:00.000Z");
  assert.equal(
    unattendedDeadlineMs({ startedMs: evening, firstRefusalMs: evening }),
    Date.parse("2026-11-25T07:00:00.000Z"),
  );
  assert.equal(unattendedDeadlineMs({ startedMs: T0, firstRefusalMs: T0 }), T0 + 2 * HOUR);
  assert.equal(unattendedMayUseOnDemand({ nowMs: T0, deadlineMs: T0 + HOUR, expectedRemainingMs: 30 * MIN }), true);
  assert.equal(
    unattendedMayUseOnDemand({ nowMs: T0, deadlineMs: T0 + 2 * HOUR, expectedRemainingMs: 30 * MIN }),
    false,
  );
});

test("countAwake: overlaps count once, On-Demand separately, clipped to the 24 h window", () => {
  const machines = [
    {
      id: "i-p",
      lifecycle: "spot" as const,
      changes: [
        { at: T0 - 30 * HOUR, state: "running" },
        { at: T0 - 23 * HOUR, state: "stopped" },
        { at: T0 - 2 * HOUR, state: "running" },
        { at: T0 - HOUR, state: "stopping" },
      ],
    },
    // The successor after a reclaim: overlaps the last 10 minutes of the Spot machine, then runs on.
    { id: "i-g", lifecycle: "on-demand" as const, changes: [{ at: T0 - 70 * MIN, state: "running" }] },
  ];
  assert.deepEqual(countAwake(machines, T0), { awakeMinutes: 60 + 120, onDemandMinutes: 70 });
  assert.deepEqual(countAwake([{ id: "i-x", lifecycle: "spot", changes: [], stateBefore: "running" }], T0), {
    awakeMinutes: 24 * 60,
    onDemandMinutes: 0,
  });
  assert.deepEqual(
    runningIntervals({ id: "i-y", lifecycle: "spot", changes: [{ at: T0 + MIN, state: "running" }] }, T0 - HOUR, T0),
    [],
  );
  assert.equal(unionMs([]), 0);
});
