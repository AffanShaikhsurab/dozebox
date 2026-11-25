// run.ts: config first, then loops, then READY=1; signals; fatal loops; the watchdog wiring.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { lastGoodPath } from "../src/config/load.ts";
import { CONFIG_EVERY_MS, runAgent, type MakeLoop, type Proc } from "../src/run.ts";
import { boxConfig, flush, harness, payload } from "./support.ts";

function fakeProc(events: string[]) {
  const handlers = new Map<string, () => void>();
  const proc: Proc = {
    once: (sig, fn) => handlers.set(sig, fn),
    exit: (code) => void events.push(`exit:${code}`),
  };
  return { proc, handlers };
}

const probe =
  (events: string[]): MakeLoop =>
  () => ({ name: "probe", everyMs: 60_000, immediate: true, tick: async () => void events.push("tick:probe") });

test("READY=1 only after the config is loaded and every loop has started", async () => {
  const h = harness();
  const { proc } = fakeProc(h.events);
  await runAgent(h.deps, proc, { extra: [probe(h.events)] });
  assert.deepEqual(h.events, ["get:config", "get:payloads/web", "tick:probe", "notify:READY=1"]);
});

test("the config loop reads SSM again every 5 minutes", async () => {
  const h = harness();
  const agent = await runAgent(h.deps, fakeProc(h.events).proc);
  h.events.length = 0;
  h.params.set("config", JSON.stringify(boxConfig({ caps: { awakeHoursPerDay: 4 } })));
  h.clock.advance(CONFIG_EVERY_MS);
  await flush();
  assert.deepEqual(h.events, ["get:config", "get:payloads/web"]);
  assert.equal(agent.config.current().box.caps.awakeHoursPerDay, 4);
  await agent.loops.stop();
});

test("no usable config: rejects before any loop or notification", async () => {
  const h = harness();
  h.params.set("config", "{");
  await assert.rejects(runAgent(h.deps, fakeProc(h.events).proc, { extra: [probe(h.events)] }), /no last good config/);
  assert.deepEqual(
    h.events.filter((e) => e.startsWith("notify:") || e.startsWith("tick:")),
    [],
  );
  assert.ok(h.events.includes("put:rec/last-error"));
  assert.equal(h.clock.pending(), 0);
});

test("invalid config with a last good copy: rec/last-error, then the loops, then READY=1", async () => {
  const saved = JSON.stringify({ box: boxConfig(), payloads: [payload()] });
  const h = harness({ files: { [lastGoodPath("/data/dozebox")]: saved } });
  h.params.set("config", JSON.stringify(boxConfig({ schema: 2 })));
  const agent = await runAgent(h.deps, fakeProc(h.events).proc, { extra: [probe(h.events)] });
  assert.deepEqual(h.events, ["get:config", "put:rec/last-error", "tick:probe", "notify:READY=1"]);
  assert.equal(agent.config.current().from, "last-good");
  await agent.loops.stop();
});

test("READY=1 failing stops the loops and rejects", async () => {
  const h = harness();
  h.faults.notify = "READY=1";
  await assert.rejects(runAgent(h.deps, fakeProc(h.events).proc), /systemd-notify READY=1 failed/);
  await flush();
  assert.equal(h.clock.pending(), 0);
});

test("SIGTERM and SIGINT: STOPPING=1, the loops stop, exit 0", async () => {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    const h = harness();
    const { proc, handlers } = fakeProc(h.events);
    const agent = await runAgent(h.deps, proc);
    assert.deepEqual([...handlers.keys()].toSorted(), ["SIGINT", "SIGTERM"]);
    handlers.get(sig)?.();
    handlers.get(sig === "SIGTERM" ? "SIGINT" : "SIGTERM")?.();
    assert.equal(await agent.done, 0);
    assert.deepEqual(h.events.slice(-2), ["notify:STOPPING=1", "exit:0"]);
    assert.equal(h.clock.pending(), 0);
    h.events.length = 0;
    h.clock.advance(CONFIG_EVERY_MS * 3);
    await flush();
    assert.deepEqual(h.events, []);
  }
});

const buggy: MakeLoop = () => ({
  name: "buggy",
  everyMs: 1_000,
  tick: async () => {
    throw new Error("impossible state");
  },
});

test("a loop with three bugs in a row stops the agent with exit 1", async () => {
  const h = harness();
  const agent = await runAgent(h.deps, fakeProc(h.events).proc, { extra: [buggy] });
  for (let i = 0; i < 3; i++) {
    h.clock.advance(1_000);
    await flush();
  }
  assert.equal(await agent.done, 1);
  assert.deepEqual(h.events.slice(-2), ["notify:STOPPING=1", "exit:1"]);
});

test("with WatchdogSec set, WATCHDOG=1 follows READY=1 at half the watchdog time, and stops for a stuck loop", async () => {
  const h = harness({ env: { watchdogEveryMs: 30_000 } });
  let hang = false;
  const maybeStuck: MakeLoop = () => ({
    name: "work",
    everyMs: 10_000,
    tick: () => (hang ? new Promise<void>(() => {}) : Promise.resolve()),
  });
  const agent = await runAgent(h.deps, fakeProc(h.events).proc, { extra: [maybeStuck] });
  const pings = () => h.events.filter((e) => e === "notify:WATCHDOG=1").length;
  assert.equal(pings(), 0);
  h.clock.advance(30_000);
  await flush();
  assert.equal(pings(), 1);
  assert.ok(h.events.indexOf("notify:READY=1") < h.events.indexOf("notify:WATCHDOG=1"));
  hang = true;
  for (let i = 0; i < 4; i++) {
    h.clock.advance(30_000);
    await flush();
  }
  // "work" last finished at 30 s; stuck after 2 x 10 s + 60 s = 80 s, so the pings stop from 120 s on.
  assert.equal(pings(), 3);
  assert.ok(h.deps.errors.recent(5).some((e) => /loops stuck: work/.test(e.message)));
  void agent.loops.stop();
});

test("operational errors in the config loop are not fatal", async () => {
  const h = harness();
  const agent = await runAgent(h.deps, fakeProc(h.events).proc);
  h.params.set("config", new RunnerError("aws_throttled", true, "ThrottlingException"));
  h.faults.put = new RunnerError("aws_throttled", true, "ThrottlingException");
  for (let i = 0; i < 5; i++) {
    h.clock.advance(CONFIG_EVERY_MS);
    await flush();
  }
  assert.equal(h.events.includes("exit:1"), false);
  assert.equal(agent.config.current().from, "last-good");
  await agent.loops.stop();
});
