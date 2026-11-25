// watchdog/loop.ts: WATCHDOG=1 only when every other loop has a recent beat.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { watchdogLoop, WATCHDOG_LOOP } from "../src/watchdog/loop.ts";

const NOW = 1_000_000;

function setup(beats: Array<{ name: string; at: number; expectEveryMs: number | null }>) {
  const sent: string[] = [];
  const loop = watchdogLoop({
    everyMs: 30_000,
    clock: { now: () => NOW },
    systemd: { notify: async (s) => void sent.push(s) },
    beats: () => beats,
  });
  return { loop, sent };
}

test("every loop alive: WATCHDOG=1 at the end of the tick", async () => {
  const { loop, sent } = setup([
    { name: "config", at: NOW - 1_000, expectEveryMs: 60_000 },
    { name: WATCHDOG_LOOP, at: 0, expectEveryMs: 1 },
  ]);
  assert.equal(loop.name, "watchdog");
  assert.equal(loop.everyMs, 30_000);
  await loop.tick(new AbortController().signal);
  assert.deepEqual(sent, ["WATCHDOG=1"]);
});

test("a stuck loop: no WATCHDOG=1, and an operational error naming the loop", async () => {
  const { loop, sent } = setup([
    { name: "config", at: NOW - 60_000, expectEveryMs: 60_000 },
    { name: "idle", at: NOW, expectEveryMs: 60_000 },
  ]);
  await assert.rejects(
    loop.tick(new AbortController().signal),
    (e) => e instanceof RunnerError && !e.retryable && e.message.endsWith("loops stuck: config"),
  );
  assert.deepEqual(sent, []);
});
