// Named regression scenarios: closed classes stay closed (part 9 §9.3), and the judge's re-introduced bugs are still
// found (the regression detection `pnpm sim:judge` runs at scale).
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { censusOf, runSeed } from "../src/run.ts";
import { describeFailure, simulate } from "../src/simulate.ts";
import { MINUTE } from "../src/world/clock.ts";

const quiet = { userSleeps: [], capacityWindows: [], tagWindows: [], serverFaults: [], horizonMs: 8 * 60 * MINUTE };

describe("regression scenarios", () => {
  it("sim-f12-handoff-wake: a wake in the same second as a reclaim hand-off ends serving", () => {
    for (const seed of [15173, 1, 2, 3, 4]) {
      const r = simulate(seed, {
        ...quiet,
        wakes: [10 * MINUTE, 40 * MINUTE],
        reclaims: [40 * MINUTE],
        reclaimOnRunningP: 0,
      });
      assert.deepEqual(r.errors, []);
      assert.ok(!r.violations.some((v) => v.rule.startsWith("wake-unresolved")), describeFailure(r));
    }
  });

  it("seed-12770-serving-late: a payload that hangs right after it first answers is still parked in time", () => {
    const faults = Array.from({ length: 60 }, (_, i) => 10 * MINUTE + i * 2000);
    for (const seed of [12770, 5, 6, 7, 8]) {
      const r = simulate(seed, { ...quiet, wakes: [10 * MINUTE], reclaims: [], serverFaults: faults });
      assert.deepEqual(r.errors, []);
      assert.ok(!r.violations.some((v) => v.rule.startsWith("idle-not-parked")), describeFailure(r));
    }
  });

  it("sim-f6-detach-running never fires", () => {
    const c = censusOf(Array.from({ length: 300 }, (_, i) => runSeed(17372 + i)));
    assert.deepEqual(
      Object.keys(c.byClass).filter((k) => k.startsWith("detach-running")),
      [],
    );
  });
});

describe("judge: re-introduced bugs are found", () => {
  it("W2: a park that leaves no record is undone by the older intent", () => {
    const c = censusOf(Array.from({ length: 30 }, (_, i) => runSeed(i + 1, { bugs: ["park-leaves-no-record"] })));
    assert.ok((c.byClass["sleep-undone/intent-before-sleep"] ?? 0) > 0, JSON.stringify(c.byClass));
  });

  it("D-E: a hidden boot error leaves a refused boot unresolved", () => {
    const c = censusOf(Array.from({ length: 300 }, (_, i) => runSeed(i + 1, { bugs: ["boot-error-hidden"] })));
    assert.ok((c.byClass["wake-unresolved/fallback-boot-failed"] ?? 0) > 0, JSON.stringify(c.byClass));
    assert.ok((c.byClass["wake-unresolved/persistent-boot-failed"] ?? 0) > 0, JSON.stringify(c.byClass));
  });
});
