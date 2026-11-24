import { strict as assert } from "node:assert";
import { test } from "node:test";
import { clockContract } from "../src/contracts/clock.ts";
import { makeFakeClock } from "../src/fakes/clock.ts";

clockContract("FakeClock", () => {
  const clock = makeFakeClock();
  return {
    clock,
    pass: async (ms) => {
      clock.advance(ms);
      await Promise.resolve();
    },
  };
});

test("FakeClock fires timers in time order, each at its own time", async () => {
  const clock = makeFakeClock(1_000);
  const seen: Array<[string, number]> = [];
  void clock.sleep(30).then(() => seen.push(["b", clock.now()]));
  void clock.sleep(10).then(() => seen.push(["a", clock.now()]));
  const t = clock.timeout(20);
  t.addEventListener("abort", () => seen.push(["t", clock.now()]));
  clock.advance(100);
  await Promise.resolve();
  assert.deepEqual(seen, [
    ["t", 1_020],
    ["a", 1_100],
    ["b", 1_100],
  ]);
  assert.equal(clock.now(), 1_100);
});

test("FakeClock: a timer set while firing fires in the same advance when it falls due", async () => {
  const clock = makeFakeClock(0);
  const fired: number[] = [];
  const outer = clock.timeout(10);
  outer.addEventListener("abort", () => {
    clock.timeout(5).addEventListener("abort", () => fired.push(clock.now()));
  });
  clock.advance(20);
  assert.deepEqual(fired, [15]);
});

test("FakeClock: an aborted sleep leaves no timer behind; next() jumps to the next timer", () => {
  const clock = makeFakeClock(0);
  const c = new AbortController();
  clock.sleep(50, c.signal).catch(() => undefined);
  c.abort(new Error("x"));
  assert.equal(clock.pending(), 0);
  clock.timeout(70);
  assert.equal(clock.next(), true);
  assert.equal(clock.now(), 70);
  assert.equal(clock.next(), false);
});

test("FakeClock refuses to go backwards", () => {
  assert.throws(() => makeFakeClock().advance(-1), RangeError);
});
