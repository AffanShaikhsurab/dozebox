// idle/park.ts: the park order (last words and wakes before the stop call), the one-park guard, and what a failure
// at each step does.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeHolds, makeFakeSupervisor } from "@dozebox/testkit/fakes";
import { park, PAYLOAD_STOP_MS, STOP_ATTEMPTS, STOP_RETRY_MS, type ParkDeps } from "../src/idle/park.ts";
import { canPark, makePhaseCell, type AgentPhase } from "../src/phase.ts";
import { flush, harness } from "./support.ts";

function setup(first: AgentPhase["phase"] = "serving", stopFails = 0) {
  const h = harness();
  const holds = makeFakeHolds();
  const payloads = makeFakeSupervisor();
  const now = h.clock.now();
  const phase = makePhaseCell(
    first === "reclaim-notice"
      ? { phase: first, since: now, terminationAt: now + 120_000 }
      : ({ phase: first, since: now } as AgentPhase),
  );
  let failures = stopFails;
  const stopped: string[] = [];
  const deps: ParkDeps = {
    clock: h.clock,
    records: h.deps.records,
    errors: h.deps.errors,
    holds,
    payloads: {
      stopAll: async (signal) => {
        h.events.push("stopAll");
        assert.equal(signal.aborted, false);
        await payloads.stopAll(signal);
      },
    },
    selfStop: {
      stopSelf: async (target) => {
        h.events.push(`stopSelf:${target.mode}`);
        if (failures-- > 0) throw new RunnerError("aws_throttled", true, "slow down");
        stopped.push(target.instanceId);
      },
    },
    target: { mode: "persistent", instanceId: "i-0123456789abcdef0" },
    phase,
    log: h.deps.log,
    strikes: () => 4,
  };
  return { h, holds, deps, phase, stopped };
}

const body = (h: ReturnType<typeof harness>, name: string) => JSON.parse(h.records.get(name) ?? "null");

test("canPark: false only while a park or a reclaim runs", () => {
  const table: Array<[AgentPhase, boolean]> = [
    [{ phase: "booting", since: 0 }, true],
    [{ phase: "serving", since: 0 }, true],
    [{ phase: "idle-pending", since: 0, sleepAt: 1 }, true],
    [{ phase: "frozen", since: 0 }, true],
    [{ phase: "reclaim-notice", since: 0, terminationAt: 1 }, false],
    [{ phase: "sleeping", since: 0, reason: "idle" }, false],
  ];
  for (const [p, want] of table) assert.equal(canPark(p), want, p.phase);
});

test("order: last words, wakes at park, fence before-stop, payloads stop, stop call, fence after-stop", async () => {
  const { h, holds, deps, phase, stopped } = setup();
  holds.holdList = [{ key: "ci:job-1", kind: "work", until: h.clock.now() + 60_000 }];
  holds.wakes = [{ payload: "web", id: "w1", reason: "nightly", expiresAt: "2026-11-26T00:00:00.000Z" }];
  h.deps.errors.add("health", new Error("x".repeat(400)));
  assert.equal(await park(deps, "idle", "idle for 30 min"), "parked");
  assert.deepEqual(h.events, [
    "put:rec/last-words",
    "put:rec/wakes",
    "put:fence/sleep-requested",
    "stopAll",
    "stopSelf:persistent",
    "put:fence/sleep-requested",
  ]);
  const words = body(h, "rec/last-words");
  assert.equal(words.parkedBecause, "idle");
  assert.equal(words.by, "agent");
  assert.equal(words.strikes, 4);
  assert.deepEqual(words.awakeBecause, ["hold:ci:job-1"]);
  assert.equal(words.recentErrors.length, 1);
  assert.ok(words.recentErrors[0].startsWith("health: ") && words.recentErrors[0].length === 300);
  const wakes = body(h, "rec/wakes");
  assert.equal(wakes.atPark, true);
  assert.equal(wakes.wakes[0].id, "w1");
  assert.deepEqual(body(h, "fence/sleep-requested").phase, "after-stop");
  assert.deepEqual(stopped, ["i-0123456789abcdef0"]);
  assert.equal(phase.get().phase, "sleeping");
});

test("a second park while one runs is refused, and a park during a reclaim notice too", async () => {
  const { deps, h } = setup();
  const first = park(deps, "user", "dozebox park");
  assert.equal(await park(deps, "idle", "idle"), "already-parking");
  await first;
  assert.equal(h.events.filter((e) => e === "stopSelf:persistent").length, 1);
  const r = setup("reclaim-notice");
  assert.equal(await park(r.deps, "idle", "idle"), "already-parking");
  assert.deepEqual(r.h.events, []);
});

test("the reclaim itself parks during its notice", async () => {
  const { deps, stopped } = setup("reclaim-notice");
  assert.equal(await park(deps, "reclaim", "spot stop at 12:00"), "parked");
  assert.equal(stopped.length, 1);
});

test("record writes that fail do not stop the park; the errors are kept", async () => {
  const { h, deps, stopped } = setup();
  h.faults.put = new RunnerError("aws_unavailable", true, "ssm down");
  assert.equal(await park(deps, "unhealthy", "15 strikes"), "parked");
  assert.deepEqual(stopped, ["i-0123456789abcdef0"]);
  assert.deepEqual(
    h.deps.errors.recent(10).map((e) => e.source),
    ["park:rec/last-words", "park:rec/wakes", "park:fence/sleep-requested", "park:fence/sleep-requested"],
  );
});

test("payloads get PAYLOAD_STOP_MS, then the stop call goes out anyway", async () => {
  const { h, deps, stopped } = setup();
  const signals: AbortSignal[] = [];
  const parked = park(
    {
      ...deps,
      payloads: {
        stopAll: (s) =>
          new Promise<void>((_resolve, reject) => {
            signals.push(s);
            s.addEventListener("abort", () => reject(new Error("units still stopping")));
          }),
      },
    },
    "idle",
    "idle",
  );
  await flush(300);
  h.clock.advance(PAYLOAD_STOP_MS);
  assert.equal(await parked, "parked");
  assert.equal(signals[0]?.aborted, true);
  assert.deepEqual(stopped, ["i-0123456789abcdef0"]);
});

test("the stop call is retried; when it fails every time the phase goes back and the park rejects", async () => {
  const retried = setup("serving", STOP_ATTEMPTS - 1);
  const ok = park(retried.deps, "idle", "idle");
  for (let i = 0; i < STOP_ATTEMPTS; i++) {
    await flush(300);
    retried.h.clock.advance(STOP_RETRY_MS);
  }
  assert.equal(await ok, "parked");
  assert.equal(retried.stopped.length, 1);

  const { h, deps, phase } = setup("serving", STOP_ATTEMPTS);
  const failed = park(deps, "idle", "idle");
  const done = assert.rejects(failed, /slow down/);
  for (let i = 0; i < STOP_ATTEMPTS; i++) {
    await flush(300);
    h.clock.advance(STOP_RETRY_MS);
  }
  await done;
  assert.equal(phase.get().phase, "serving");
  assert.equal(h.events.filter((e) => e.startsWith("stopSelf")).length, STOP_ATTEMPTS);
});
