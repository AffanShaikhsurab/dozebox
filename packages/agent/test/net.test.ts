import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeFakeHostStats } from "@dozebox/testkit/fakes";
import { NET_LOOP_MS, netLoop, type NetState } from "../src/net/index.ts";

const signal = new AbortController().signal;

function setup() {
  const stats = makeFakeHostStats();
  let now = 1000;
  const states: NetState[] = [];
  const timeouts: number[] = [];
  const flaky = { failTx: false };
  const loop = netLoop({
    stats: {
      space: stats.space,
      reach: stats.reach,
      txBytes: async () => (flaky.failTx ? Promise.reject(new Error("no sysfs")) : stats.txBytes()),
    },
    hosts: ["a.example", "b.example"],
    now: () => now,
    onState: (s) => states.push(s),
    timeout: (ms) => (timeouts.push(ms), new AbortController().signal),
  });
  return { stats, flaky, loop, states, timeouts, setNow: (n: number) => void (now = n) };
}

test("strikes grow while neither host answers and reset on any answer", async () => {
  const { stats, loop, states, timeouts, setNow } = setup();
  assert.equal(loop.name, "net");
  assert.equal(loop.everyMs, NET_LOOP_MS);
  assert.equal(loop.immediate, true);
  await loop.tick(signal);
  await loop.tick(signal);
  assert.deepEqual(
    states.map((s) => [s.strikes, s.lastOkAt]),
    [
      [1, null],
      [2, null],
    ],
  );
  stats.reachable.add("b.example");
  setNow(2000);
  await loop.tick(signal);
  assert.deepEqual([states[2]?.strikes, states[2]?.lastOkAt], [0, 2000]);
  stats.reachable.clear();
  setNow(3000);
  await loop.tick(signal);
  assert.deepEqual([states[3]?.strikes, states[3]?.lastOkAt], [1, 2000]);
  assert.ok(timeouts.every((t) => t === 5000));
});

test("txBytes counts bytes since the first reading, across a counter reset", async () => {
  const { stats, loop, states } = setup();
  stats.tx = 1000;
  await loop.tick(signal);
  stats.tx = 1500;
  await loop.tick(signal);
  stats.tx = 2000;
  await loop.tick(signal);
  stats.tx = 300;
  await loop.tick(signal);
  stats.tx = 400;
  await loop.tick(signal);
  assert.deepEqual(
    states.map((s) => s.txBytes),
    [0, 500, 1000, 1300, 1400],
  );
});

test("a txBytes read failure leaves the total unchanged", async () => {
  const { stats, flaky, loop, states } = setup();
  stats.tx = 100;
  await loop.tick(signal);
  stats.tx = 200;
  await loop.tick(signal);
  flaky.failTx = true;
  await loop.tick(signal);
  flaky.failTx = false;
  stats.tx = 250;
  await loop.tick(signal);
  assert.deepEqual(
    states.map((s) => s.txBytes),
    [0, 100, 100, 150],
  );
});
