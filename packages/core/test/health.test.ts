import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  decideHealth,
  HEALTH_DEFAULTS,
  missedLoops,
  NEW_HEALTH_STATE,
  type HealthCheck,
  type HealthDecision,
  type HealthState,
} from "../src/health/strikes.ts";

const T0 = Date.UTC(2026, 10, 24, 21, 0, 0);
const MIN = 60_000;
const check = (over: Partial<HealthCheck> = {}): HealthCheck => ({
  now: T0,
  served: true,
  healthy: false,
  missedLoops: [],
  netUp: true,
  unitFailed: false,
  ...over,
});

/** Runs `n` checks a minute apart from `state`, returning every decision. */
function run(n: number, over: Partial<HealthCheck> = {}, state: HealthState = NEW_HEALTH_STATE): HealthDecision[] {
  const out: HealthDecision[] = [];
  let s = state;
  for (let k = 0; k < n; k += 1) {
    const d = decideHealth(s, check({ ...over, now: (over.now ?? T0) + k * MIN }));
    out.push(d);
    s = d.state;
  }
  return out;
}
const kinds = (ds: HealthDecision[]) => ds.map((d) => d.action.kind);

// Part 4 §4.12 table, and the rows of legacy/runner/test/box/watchdog.node-test.ts that are decisions.
test("restarts at the 5th and 10th unhealthy check, then parks at the 15th and says it tried", () => {
  const ds = run(15);
  const k = kinds(ds);
  assert.equal(k[4], "restart");
  assert.equal(k[9], "restart");
  assert.deepEqual(
    k.filter((x) => x !== "count"),
    ["restart", "restart", "park"],
  );
  assert.deepEqual(ds[14]?.action, { kind: "park", reason: "unhealthy", strikes: 15, restarts: 2 });
});

test("a healthy check ends the episode: strikes start over, so strikes must be consecutive", () => {
  const first = run(4);
  const reset = decideHealth(first[3]!.state, check({ healthy: true, now: T0 + 4 * MIN }));
  assert.equal(reset.action.kind, "ok");
  assert.equal(reset.state.strikes, 0);
  const again = run(4, { now: T0 + 5 * MIN }, reset.state);
  assert.deepEqual(kinds(again), ["count", "count", "count", "count"]);
});

test("restarts stay counted for the rolling hour: 2 restarts this hour parks at the next restart point", () => {
  const ds = run(10);
  const healthy = decideHealth(ds[9]!.state, check({ healthy: true, now: T0 + 10 * MIN }));
  assert.deepEqual(healthy.state.restarts, [T0 + 4 * MIN, T0 + 9 * MIN]);
  const next = run(5, { now: T0 + 11 * MIN }, healthy.state);
  assert.deepEqual(next[4]?.action, { kind: "park", reason: "unhealthy", strikes: 5, restarts: 2 });
  // An hour later the restarts have aged out and a restart is allowed again.
  const late = run(5, { now: T0 + 80 * MIN }, healthy.state);
  assert.equal(late[4]?.action.kind, "restart");
});

test("does not strike before this boot has served; the first healthy check writes serving", () => {
  assert.deepEqual(kinds(run(20, { served: false })), Array(20).fill("not-serving"));
  const first = decideHealth(NEW_HEALTH_STATE, check({ served: false, healthy: true }));
  assert.equal(first.action.kind, "serving");
});

test("a missed loop beat counts as one unhealthy check per minute while missed", () => {
  const ds = run(5, { healthy: true, missedLoops: ["watcher"] });
  assert.deepEqual(kinds(ds), ["count", "count", "count", "count", "restart"]);
  assert.deepEqual(ds[4]?.action, { kind: "restart", strikes: 5, restart: 1, cause: "loop:watcher" });
});

test("network down: no restart and no park, one net-down alert at the 3rd check, counting resumes after", () => {
  const ds = run(20, { netUp: false });
  assert.deepEqual(
    kinds(ds).filter((k) => k !== "hold"),
    ["net-down"],
  );
  assert.equal(kinds(ds)[2], "net-down");
  assert.equal(ds[19]?.state.strikes, 0);
  const back = decideHealth(ds[19]!.state, check({ now: T0 + 20 * MIN }));
  assert.deepEqual(back.action, { kind: "count", strikes: 1, cause: "check" });
  assert.equal(back.netBack, true);
});

test("a blip shorter than three checks is not an outage and does not reset the strikes", () => {
  const ds = run(3);
  const blip = run(2, { netUp: false, now: T0 + 3 * MIN }, ds[2]!.state);
  assert.deepEqual(kinds(blip), ["hold", "hold"]);
  const after = decideHealth(blip[1]!.state, check({ now: T0 + 5 * MIN }));
  assert.deepEqual(after.action, { kind: "count", strikes: 4, cause: "check" });
  assert.equal(after.netBack, false);
});

test("a failed unit parks now, whatever the strikes", () => {
  assert.deepEqual(decideHealth(NEW_HEALTH_STATE, check({ unitFailed: true })).action, {
    kind: "park",
    reason: "unit-failed",
    strikes: 0,
    restarts: 0,
  });
});

test("never restarts under a park limit lower than the first restart point", () => {
  const ds = run(3, { config: { ...HEALTH_DEFAULTS, parkAtStrikes: 3 } });
  assert.deepEqual(kinds(ds), ["count", "count", "park"]);
});

test("missedLoops: only loops that declared a deadline, and only past it", () => {
  const beats = [
    { name: "watcher", at: T0 - 16 * MIN, expectEveryMs: 15 * MIN },
    { name: "idle", at: T0 - 4 * MIN, expectEveryMs: 5 * MIN },
    { name: "free", at: T0 - 600 * MIN, expectEveryMs: null },
  ];
  assert.deepEqual(missedLoops(beats, T0), ["watcher"]);
  assert.deepEqual(missedLoops(beats, T0 - 2 * MIN), []);
});
