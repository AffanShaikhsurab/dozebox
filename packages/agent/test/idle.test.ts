// idle/loop.ts and idle/activity.ts: only a serving box parks for idle, an idle verdict is confirmed after 10 s, and
// health-only CPU activity keeps the box awake.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PayloadDefinition } from "@dozebox/protocol/payload";
import { makeFakeClock, makeFakeHolds } from "@dozebox/testkit/fakes";
import { cpuStatPath, makeActivitySampler, usageUsec } from "../src/idle/activity.ts";
import { IDLE_CONFIRM_MS, IDLE_LOOP_MS, idleLoop } from "../src/idle/loop.ts";
import type { AgentPhase } from "../src/phase.ts";
import { flush, payload } from "./support.ts";

const MIN = 60_000;

function setup(phase: AgentPhase["phase"] = "serving") {
  const clock = makeFakeClock();
  const holds = makeFakeHolds();
  const parks: string[] = [];
  const verdicts: string[] = [];
  let activity: number | null = null;
  const servingSince = clock.now();
  const loop = idleLoop({
    clock,
    holds,
    idleMs: () => 30 * MIN,
    viewingGraceMs: () => 10 * MIN,
    servingSince: () => servingSince,
    lastActivityAt: async () => activity,
    phase: () => ({ phase, since: servingSince }) as AgentPhase,
    onVerdict: (v) => verdicts.push(v.kind),
    park: async (reason, detail) => void parks.push(`${reason}: ${detail}`),
  });
  const tick = async () => {
    const t = loop.tick(new AbortController().signal);
    await flush(50);
    clock.advance(IDLE_CONFIRM_MS);
    await t;
  };
  return { clock, holds, parks, verdicts, loop, tick, setActivity: (at: number | null) => (activity = at) };
}

test("the loop is the plan's: every 30 s, named idle", () => {
  const { loop } = setup();
  assert.equal(loop.name, "idle");
  assert.equal(loop.everyMs, IDLE_LOOP_MS);
});

test("awake within idleMinutes of serving; idle after it, confirmed, then parks with reason idle", async () => {
  const s = setup();
  s.clock.advance(29 * MIN);
  await s.tick();
  assert.deepEqual(s.parks, []);
  s.clock.advance(2 * MIN);
  await s.tick();
  assert.equal(s.parks.length, 1);
  assert.match(s.parks[0] ?? "", /^idle: idle for 31 min/);
  assert.deepEqual(s.verdicts, ["awake", "idle", "idle"]);
});

test("activity in the confirm window cancels the park", async () => {
  const s = setup();
  s.clock.advance(40 * MIN);
  const t = s.loop.tick(new AbortController().signal);
  await flush(50);
  s.setActivity(s.clock.now());
  s.clock.advance(IDLE_CONFIRM_MS);
  await t;
  assert.deepEqual(s.parks, []);
});

test("holds and health-only activity keep it awake", async () => {
  const s = setup();
  s.clock.advance(40 * MIN);
  s.holds.holdList = [{ key: "job", kind: "work", until: s.clock.now() + MIN }];
  await s.tick();
  assert.deepEqual(s.parks, []);
  s.holds.holdList = [];
  s.setActivity(s.clock.now() - 5 * MIN);
  await s.tick();
  assert.deepEqual(s.parks, []);
});

test("a box that is booting, parking or reclaimed is not parked for idle", async () => {
  for (const phase of ["booting", "sleeping", "reclaim-notice", "frozen"] as const) {
    const s = setup(phase);
    s.clock.advance(5 * 60 * MIN);
    await s.tick();
    assert.deepEqual(s.parks, [], phase);
  }
});

test("cpu activity: above cpuPercent over a 60 s window, only while healthy, only health-only payloads", async () => {
  const text = new Map<string, string>();
  let healthy = true;
  const defs = [
    payload({ name: "web", activity: { cpuPercent: 5 } }),
    payload({ name: "api", protocol: "v1" }),
  ] as PayloadDefinition[];
  const s = makeActivitySampler({
    files: { readText: async (p) => text.get(p) ?? null },
    payloads: () => defs,
    healthy: () => healthy,
  });
  const set = (usec: number) => text.set(cpuStatPath("web"), `usage_usec ${usec}\nuser_usec 1\n`);
  set(0);
  assert.equal(await s.sample(0), null);
  set(1_000_000); // 1 s of CPU in 30 s: not yet a full window
  assert.equal(await s.sample(30_000), null);
  set(4_000_000); // 4 s in 60 s = 6.7%
  assert.equal(await s.sample(60_000), 60_000);
  set(4_100_000); // 3.1 s over the last 60 s window from 30 s: 5.2%
  assert.equal(await s.sample(90_000), 90_000);
  set(4_200_000); // 0.2 s over 60 s: idle; the last activity stays
  assert.equal(await s.sample(150_000), 90_000);
  healthy = false;
  set(60_000_000);
  assert.equal(await s.sample(210_000), 90_000);
  assert.equal(usageUsec("nr_periods 0\n"), null);
  assert.equal(
    cpuStatPath("web"),
    "/sys/fs/cgroup/dozebox.slice/dozebox-payloads.slice/dozebox-payload@web.service/cpu.stat",
  );
});
