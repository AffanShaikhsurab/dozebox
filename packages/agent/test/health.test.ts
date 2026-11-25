// watchdog/health.ts: the first healthy check serves, strikes restart then park, a failed unit parks at once.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeFakeClock, makeFakeSupervisor } from "@dozebox/testkit/fakes";
import { makePhaseCell } from "../src/phase.ts";
import { healthLoop } from "../src/watchdog/health.ts";
import { harness } from "./support.ts";

function setup() {
  const clock = makeFakeClock();
  const sup = makeFakeSupervisor();
  sup.units = [{ name: "web", active: "active", activeSince: clock.now(), restarts: 0 }];
  sup.health = [{ name: "web", ok: false, detail: "HTTP 503" }];
  const phase = makePhaseCell({ phase: "booting", since: clock.now() });
  const served: string[] = [];
  const parks: string[] = [];
  const loop = healthLoop({
    clock,
    log: harness().deps.log,
    payloads: sup,
    everyMs: 60_000,
    config: () => ({ restartAtStrikes: [5, 10], parkAtStrikes: 15, restartsPerHour: 2 }),
    phase,
    onServing: async (p) => void served.push(p),
    park: async (reason, detail) => void parks.push(`${reason}: ${detail}`),
  });
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await loop.tick(new AbortController().signal);
      clock.advance(60_000);
    }
  };
  const ok = (v: boolean) => (sup.health = [{ name: "web", ok: v, detail: v ? "HTTP 200" : "HTTP 503" }]);
  return { clock, sup, phase, served, parks, loop, tick, ok };
}

test("unhealthy before serving counts nothing; the first healthy check serves once", async () => {
  const s = setup();
  await s.tick(20);
  assert.deepEqual([s.served, s.parks, s.loop.strikes()], [[], [], 0]);
  assert.equal(s.loop.servingSince(), null);
  s.ok(true);
  await s.tick(2);
  assert.deepEqual(s.served, ["web"]);
  assert.equal(s.phase.get().phase, "serving");
  assert.equal(s.loop.healthy("web"), true);
  assert.equal(typeof s.loop.servingSince(), "number");
  assert.equal(s.loop.immediate, true);
});

test("after serving: restart at strikes 5 and 10, park at 15", async () => {
  const s = setup();
  s.ok(true);
  await s.tick();
  s.ok(false);
  await s.tick(4);
  assert.deepEqual(s.sup.calls, []);
  await s.tick();
  assert.deepEqual(s.sup.calls, ["restart:web"]);
  await s.tick(5);
  assert.deepEqual(s.sup.calls, ["restart:web", "restart:web"]);
  await s.tick(4);
  assert.deepEqual(s.parks, []);
  await s.tick();
  assert.equal(s.parks.length, 1);
  assert.match(s.parks[0] ?? "", /^unhealthy: unhealthy after 15 checks \(2 restarts this hour\): web: HTTP 503$/);
});

test("a healthy check resets the strikes", async () => {
  const s = setup();
  s.ok(true);
  await s.tick();
  s.ok(false);
  await s.tick(3);
  assert.equal(s.loop.strikes(), 3);
  s.ok(true);
  await s.tick();
  assert.equal(s.loop.strikes(), 0);
});

test("a unit in ActiveState=failed parks at once, served or not", async () => {
  const s = setup();
  s.sup.units = [{ name: "web", active: "failed", activeSince: null, restarts: 5 }];
  await s.tick();
  assert.deepEqual(s.parks, ["unhealthy: payload unit failed: web"]);
});

test("no checks while the box parks or is reclaimed", async () => {
  const s = setup();
  s.phase.set({ phase: "sleeping", since: 0, reason: "idle" });
  s.sup.units = [{ name: "web", active: "failed", activeSince: null, restarts: 5 }];
  await s.tick(3);
  assert.deepEqual(s.parks, []);
});
