// GET /v1/status: one golden ControlStatus per public state, each checked against the protocol schema, plus the
// projection rows behind them. Regenerate the goldens with DOZEBOX_UPDATE_GOLDEN=1 and review the diff.
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CONTROL_STATES, ControlStatus } from "@dozebox/protocol/control";
import Value from "typebox/value";
import type { MachineView } from "../src/ports/compute.ts";
import { projectState, REPLACING_MS, WAITING_CAPACITY_MS, type ProjectFacts } from "../src/status/project.ts";
import { KEYS } from "../src/state/keys.ts";
import { makeWorld, type World } from "./fixture.ts";

const GOLDEN = join(import.meta.dirname, "golden");
const MIN = 60_000;

function persistent(w: World, state: "running" | "stopped"): string {
  return w.aws.ec2.addMachine({ boxId: "main", role: "persistent", state, lifecycle: "spot" });
}

const writer = (instanceId: string) => ({ instanceId, bootId: "boot-0001" });
const iso = (ms: number) => new Date(ms).toISOString();

async function putRecord(w: World, name: string, value: unknown) {
  await w.deps.records.put(name, JSON.stringify(value), { tier: name === "rec/liveness" ? "Advanced" : "Standard" });
}

/** Each state's world, set up through the same ports production uses. */
const SCENES: Readonly<Record<(typeof CONTROL_STATES)[number], (w: World) => Promise<void>>> = {
  parked: async (w) => {
    persistent(w, "stopped");
    w.aws.clock.advance(5 * MIN);
    await w.call("POST", "/v1/park");
  },
  launching: async (w) => {
    persistent(w, "stopped");
    w.aws.clock.advance(5 * MIN);
    await w.call("POST", "/v1/wake");
  },
  running: async (w) => {
    const id = persistent(w, "running");
    w.aws.clock.advance(2 * MIN);
    await w.call("POST", "/v1/wake");
    const at = iso(w.aws.clock.now());
    await putRecord(w, "rec/serving", { v: 1, at, writer: writer(id), payload: "web" });
    await putRecord(w, "config", { brand: { name: "Lab" } });
    await putRecord(w, "rec/liveness", {
      v: 1,
      at,
      writer: writer(id),
      agent: { version: "1.0.0", ok: true, strikes: 0 },
      payloads: [
        {
          name: "web",
          health: "ok",
          restartsThisHour: 0,
          lastProgressAt: at,
          progress: {},
          holds: { work: 1, wait: 0, until: null, reasons: ["web/build-7"] },
        },
      ],
      presence: { interactiveUntil: null, lastInteractiveAt: null },
      idle: { since: null, sleepAt: null },
      net: { ok: true, downSince: null },
      disk: { level: "ok", freePct: 71 },
      undelivered: [],
    });
    w.aws.clock.advance(MIN);
  },
  "waiting-capacity": async (w) => {
    persistent(w, "stopped");
    await w.call("POST", "/v1/wake");
    w.aws.clock.advance(30_000);
    await w.deps.state.putFenced(KEYS.lastStartError, { at: w.aws.clock.now(), kind: "capacity" }, 1);
  },
  replacing: async (w) => {
    const id = persistent(w, "stopped");
    await w.call("POST", "/v1/wake");
    w.aws.clock.advance(MIN);
    await w.deps.state.putFenced(KEYS.interruption, { instanceId: id, at: w.aws.clock.now() }, w.aws.clock.now());
    w.aws.clock.advance(MIN);
  },
  "stopped-error": async (w) => {
    const id = persistent(w, "stopped");
    w.aws.clock.advance(MIN);
    await putRecord(w, "rec/last-error", {
      v: 1,
      at: iso(w.aws.clock.now()),
      writer: writer(id),
      source: "boot:mount",
      message: "the data volume did not attach",
    });
    await putRecord(w, "rec/last-words", {
      v: 1,
      at: iso(w.aws.clock.now()),
      writer: writer(id),
      parkedBecause: "unhealthy",
      by: "agent",
      detail: "boot failed",
      recentErrors: [],
      strikes: 3,
      awakeBecause: [],
    });
  },
};

describe("ControlStatus golden per public state", () => {
  for (const state of CONTROL_STATES) {
    test(state, async () => {
      const w = makeWorld();
      await SCENES[state](w);
      const res = await w.call("GET", "/v1/status");
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-type"], "application/json");
      assert.ok(
        Value.Check(ControlStatus, res.json),
        [...Value.Errors(ControlStatus, res.json)].map((e) => e.message).join(),
      );
      const file = join(GOLDEN, `status-${state}.json`);
      if (process.env["DOZEBOX_UPDATE_GOLDEN"] === "1") writeFileSync(file, `${JSON.stringify(res.json, null, 2)}\n`);
      assert.deepEqual(res.json, JSON.parse(readFileSync(file, "utf8")));
      // Building a status only reads.
      assert.deepEqual(
        w.computeCalls.filter((c) => !c.op.startsWith("describe")),
        [],
      );
    });
  }
});

const T0 = Date.parse("2026-11-25T08:00:00.000Z");
const machine = (over: Partial<MachineView> = {}): MachineView => ({
  id: "i-1",
  state: "stopped",
  lifecycle: "spot",
  launchedAt: T0 - 60 * MIN,
  stoppingAt: T0 - 30 * MIN,
  spotRequest: "disabled",
  ...over,
});
const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  now: T0,
  desired: { want: "asleep", since: T0 - 30 * MIN, reason: "park:user", origin: "user" },
  persistent: machine(),
  groups: [],
  lastErrorAt: null,
  interruption: null,
  lastStartError: null,
  ...over,
});
const awake = { want: "awake" as const, since: T0 - MIN, reason: "wake:person", origin: "user" as const };

describe("projectState", () => {
  test("a running machine is running whatever is desired; since is its launch", () => {
    const p = projectState(facts({ persistent: machine({ state: "running" }) }));
    assert.deepEqual([p.state, p.since, p.machine], ["running", T0 - 60 * MIN, "persistent"]);
  });
  test("a running fallback machine is running on the fallback", () => {
    const g = { role: "fallback" as const, desired: 1 as const, machines: [machine({ id: "i-2", state: "running" })] };
    const p = projectState(facts({ desired: awake, groups: [g] }));
    assert.deepEqual([p.state, p.machine, p.instance?.id], ["running", "fallback", "i-2"]);
  });
  test("pending is launching since the wake", () => {
    const p = projectState(facts({ desired: awake, persistent: machine({ state: "pending" }) }));
    assert.deepEqual([p.state, p.since], ["launching", awake.since]);
  });
  test("a box error after the newest launch is stopped-error, until a newer wake", () => {
    assert.equal(projectState(facts({ lastErrorAt: T0 - 40 * MIN })).state, "stopped-error");
    assert.equal(projectState(facts({ lastErrorAt: T0 - 90 * MIN })).state, "parked");
    assert.equal(projectState(facts({ desired: awake, lastErrorAt: T0 - 40 * MIN })).state, "launching");
  });
  test("an interruption of our machine after the wake is replacing for 15 minutes", () => {
    const i = { instanceId: "i-1", at: T0 - 30_000 };
    assert.equal(projectState(facts({ desired: awake, interruption: i })).state, "replacing");
    assert.equal(projectState(facts({ desired: awake, interruption: i, now: i.at + REPLACING_MS })).state, "launching");
    assert.equal(projectState(facts({ desired: awake, interruption: { ...i, instanceId: "i-9" } })).state, "launching");
    assert.equal(
      projectState(facts({ desired: awake, interruption: { ...i, at: awake.since - 1 } })).state,
      "launching",
    );
  });
  test("a capacity refusal after the wake, or a group with no machine for 3 minutes, is waiting-capacity", () => {
    const e = { at: T0 - 10_000, kind: "capacity" as const };
    assert.equal(projectState(facts({ desired: awake, lastStartError: e })).state, "waiting-capacity");
    assert.equal(projectState(facts({ desired: awake, lastStartError: { ...e, kind: "refused" } })).state, "launching");
    const g = { role: "fallback" as const, desired: 1 as const, machines: [] };
    const late = { ...awake, since: T0 - WAITING_CAPACITY_MS };
    assert.equal(projectState(facts({ desired: late, groups: [g] })).state, "waiting-capacity");
    assert.equal(projectState(facts({ desired: awake, groups: [g] })).state, "launching");
  });
  test("parked since the later of the stop and the park; no machine at all is parked now", () => {
    assert.deepEqual(projectState(facts()).since, T0 - 30 * MIN);
    const none = projectState(facts({ persistent: null, desired: { ...awake, want: "asleep", since: 0 } }));
    assert.deepEqual([none.state, none.since, none.machine], ["parked", T0, undefined]);
  });
});
