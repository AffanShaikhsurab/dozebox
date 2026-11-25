// loops.ts: ticks on the clock, beats, errors vs bugs, three bugs in a row, stop.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeClock } from "@dozebox/testkit/fakes";
import { makeJsonLogger } from "../src/adapters/log.ts";
import { makeErrorLog } from "../src/errors.ts";
import { BUGS_IN_A_ROW, runLoops, STOP_GRACE_MS, stuckAfterMs, type Loop } from "../src/loops.ts";
import { flush } from "./support.ts";

function setup() {
  const clock = makeFakeClock();
  const lines: string[] = [];
  const errors = makeErrorLog(clock.now);
  const fatal: string[] = [];
  const deps = {
    clock,
    log: makeJsonLogger((l) => lines.push(l), clock.now),
    errors,
    onFatal: (r: string) => fatal.push(r),
  };
  return { clock, lines, errors, fatal, deps };
}

const step = async (clock: ReturnType<typeof makeFakeClock>, ms: number) => {
  clock.advance(ms);
  await flush();
};

test("a loop ticks every interval, first after one interval unless immediate", async () => {
  const s = setup();
  const ticks: string[] = [];
  const loops: Loop[] = [
    { name: "a", everyMs: 1_000, tick: async () => void ticks.push("a") },
    { name: "b", everyMs: 1_000, immediate: true, tick: async () => void ticks.push("b") },
  ];
  const r = runLoops(s.deps, loops);
  await flush();
  assert.deepEqual(ticks, ["b"]);
  await step(s.clock, 1_000);
  assert.deepEqual(ticks.toSorted(), ["a", "b", "b"]);
  await r.stop();
});

test("beats: start time before the first tick, then the end of each finished tick", async () => {
  const s = setup();
  const t0 = s.clock.now();
  const r = runLoops(s.deps, [{ name: "a", everyMs: 1_000, tick: async () => {} }]);
  assert.deepEqual(r.beats(), [{ name: "a", at: t0, expectEveryMs: stuckAfterMs(1_000) }]);
  await step(s.clock, 1_000);
  assert.equal(r.beats()[0]?.at, t0 + 1_000);
  assert.equal(stuckAfterMs(1_000), 62_000);
  await r.stop();
});

test("operational errors are logged and kept, never fatal; the beat does not move", async () => {
  const s = setup();
  const t0 = s.clock.now();
  const r = runLoops(s.deps, [
    { name: "a", everyMs: 10, tick: async () => Promise.reject(new RunnerError("aws_throttled", true, "slow down")) },
  ]);
  for (let i = 0; i < 10; i++) await step(s.clock, 10);
  assert.deepEqual(s.fatal, []);
  assert.equal(r.beats()[0]?.at, t0);
  assert.equal(s.errors.recent(100).length, 10);
  assert.deepEqual(s.errors.recent(1)[0], { at: t0 + 100, source: "a", message: "slow down" });
  assert.ok(s.lines.every((l) => JSON.parse(l).level === "warn"));
  await r.stop();
});

test(`${BUGS_IN_A_ROW} bugs in a row from one loop are fatal, once; a good tick resets the count`, async () => {
  const s = setup();
  const plan = ["bug", "bug", "ok", "bug", "bug", "bug", "bug"];
  let i = 0;
  const r = runLoops(s.deps, [
    {
      name: "a",
      everyMs: 10,
      tick: async () => {
        if (plan[i++] === "bug") throw new TypeError("x is undefined");
      },
    },
  ]);
  for (let k = 0; k < 5; k++) await step(s.clock, 10);
  assert.deepEqual(s.fatal, []);
  await step(s.clock, 10);
  assert.deepEqual(s.fatal, ["a: 3 bugs in a row"]);
  await step(s.clock, 10);
  assert.equal(i, 6, "the loop stops after the fatal bug");
  const bug = JSON.parse(s.lines.find((l) => l.includes("bug in tick")) ?? "{}");
  assert.equal(bug.level, "error");
  assert.match(bug.error.stack, /TypeError/);
  await r.stop();
});

test("stop aborts the sleeps and the running tick's signal; no tick after stop", async () => {
  const s = setup();
  let ticks = 0;
  let aborted = false;
  const r = runLoops(s.deps, [
    {
      name: "a",
      everyMs: 10,
      tick: (signal) =>
        new Promise<void>((resolve) => {
          ticks++;
          signal.addEventListener("abort", () => ((aborted = true), resolve()), { once: true });
        }),
    },
    { name: "b", everyMs: 10, tick: async () => void ticks++ },
  ]);
  await step(s.clock, 10);
  const before = ticks;
  await r.stop();
  await r.stop();
  assert.equal(aborted, true);
  await step(s.clock, 100);
  assert.equal(ticks, before);
  assert.equal(s.clock.pending(), 0);
});

test(`stop waits at most ${STOP_GRACE_MS} ms for a tick that ignores its signal`, async () => {
  const s = setup();
  const r = runLoops(s.deps, [{ name: "a", everyMs: 10, immediate: true, tick: () => new Promise<void>(() => {}) }]);
  let stopped = false;
  void r.stop().then(() => (stopped = true));
  await flush();
  assert.equal(stopped, false);
  await step(s.clock, STOP_GRACE_MS);
  assert.equal(stopped, true);
});

test("two loops with one name are refused", () => {
  const s = setup();
  const l: Loop = { name: "a", everyMs: 1, tick: async () => {} };
  assert.throws(() => runLoops(s.deps, [l, l]), /two loops are named "a"/);
});
