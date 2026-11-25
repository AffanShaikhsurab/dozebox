// The typed reconciler (part 6 §6.3) with rules R1 and R2: a row per rule, a row per closed simulator class, and an
// exhaustive check of the safety rules over every combination of observed facts.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  agentPark,
  decideReconcile,
  type Action,
  type Desired,
  type Ec2State,
  type Observed,
} from "../src/reconcile/decide.ts";

const T0 = Date.UTC(2026, 10, 24, 21, 0, 0);
const MIN = 60_000;
const awake = (since = T0 - 2 * MIN): Desired => ({ want: "awake", since, reason: "wake:person", origin: "user" });
const asleep = (since = T0 - MIN): Desired => ({ want: "asleep", since, reason: "park:user", origin: "user" });
const P = "i-persistent";
const G = "i-group";
const persistent = (state: Ec2State, over: Partial<NonNullable<Observed["persistent"]>> = {}) => ({
  id: P,
  state,
  stoppingAt: state === "stopped" ? T0 - 60 * MIN : null,
  spotRequest: "disabled" as const,
  launchedAt: T0 - 120 * MIN,
  ...over,
});
const base: Observed = {
  now: T0,
  persistent: persistent("stopped"),
  group: { desired: 0, instances: [] },
  volume: { id: "vol-1", attachedTo: P, active: true },
  sleepFence: null,
  interruption: null,
  lastStartError: null,
  frozen: false,
  onDemandAllowed: true,
  lastLaunchAt: null,
};
const groupUp = { desired: 1 as const, instances: [{ id: G, state: "running" as const, launchedAt: T0 - MIN }] };
const groupLaunching = { desired: 1 as const, instances: [] };

const rows: ReadonlyArray<{ name: string; desired: Desired; o: Partial<Observed>; expect: Action }> = [
  // Steady states.
  { name: "parked and asleep: nothing", desired: asleep(), o: {}, expect: { kind: "none", why: "parked" } },
  {
    name: "awake and running: nothing",
    desired: awake(),
    o: { persistent: persistent("running") },
    expect: { kind: "none", why: "awake" },
  },
  // The wake path.
  { name: "awake, stopped: start", desired: awake(), o: {}, expect: { kind: "start-persistent", id: P } },
  {
    name: "SIM-F4: awake while stopping: wait, then start once stopped",
    desired: awake(),
    o: { persistent: persistent("stopping") },
    expect: { kind: "wait", why: "stopping", recheckInMs: 30_000 },
  },
  {
    name: "a Spot request still stopping: wait for 3 min",
    desired: awake(),
    o: { persistent: persistent("stopped", { spotRequest: "active", stoppingAt: T0 - MIN }) },
    expect: { kind: "wait", why: "spot-request-stopping", recheckInMs: 30_000 },
  },
  {
    name: "a Spot request still stopping after 3 min: group",
    desired: awake(),
    o: { persistent: persistent("stopped", { spotRequest: "active", stoppingAt: T0 - 4 * MIN }) },
    expect: { kind: "raise-fallback", why: "refused" },
  },
  {
    name: "a start refused for capacity since this wake: group",
    desired: awake(),
    o: { lastStartError: { at: T0 - 30_000, kind: "capacity" } },
    expect: { kind: "raise-fallback", why: "capacity" },
  },
  {
    name: "a start error older than this wake is not this wake's",
    desired: awake(),
    o: { lastStartError: { at: T0 - 10 * MIN, kind: "capacity" } },
    expect: { kind: "start-persistent", id: P },
  },
  {
    name: "another start error: group",
    desired: awake(),
    o: { lastStartError: { at: T0 - 30_000, kind: "other" } },
    expect: { kind: "raise-fallback", why: "start-failed" },
  },
  {
    name: "persistent instance terminated: group",
    desired: awake(),
    o: { persistent: persistent("terminated") },
    expect: { kind: "raise-fallback", why: "start-failed" },
  },
  {
    name: "group mode, awake, group down: raise it",
    desired: awake(),
    o: { persistent: null },
    expect: { kind: "raise-fallback", why: "group" },
  },
  {
    name: "group mode, awake, group up: nothing",
    desired: awake(),
    o: { persistent: null, group: groupUp },
    expect: { kind: "none", why: "group-up" },
  },
  // Reclaim hand-off.
  {
    name: "a Spot warning during this wake: raise the successor",
    desired: awake(T0 - 60 * MIN),
    o: { persistent: persistent("running"), interruption: { instanceId: P, at: T0 - MIN } },
    expect: { kind: "raise-fallback", why: "interrupted" },
  },
  {
    name: "the successor is launching while the old instance still runs: leave both",
    desired: awake(T0 - 60 * MIN),
    o: { persistent: persistent("running"), group: groupLaunching, interruption: { instanceId: P, at: T0 - MIN } },
    expect: { kind: "none", why: "replacing" },
  },
  {
    name: "the old instance stopped: release the volume to the successor",
    desired: awake(T0 - 60 * MIN),
    o: { group: groupLaunching, interruption: { instanceId: P, at: T0 - 2 * MIN } },
    expect: { kind: "release-volume", volumeId: "vol-1", from: P },
  },
  {
    name: "a fallback after a stale holder: release the volume once stopped",
    desired: awake(),
    o: { group: groupUp },
    expect: { kind: "release-volume", volumeId: "vol-1", from: P },
  },
  {
    name: "fallback holds the volume and serves: nothing",
    desired: awake(),
    o: { group: groupUp, volume: { id: "vol-1", attachedTo: G, active: true } },
    expect: { kind: "none", why: "fallback-up" },
  },
  // Holder rules.
  {
    name: "the group holds the volume: stop the live persistent one",
    desired: awake(),
    o: { persistent: persistent("running"), group: groupUp, volume: { id: "vol-1", attachedTo: G, active: true } },
    expect: { kind: "stop-persistent", id: P, why: "loser" },
  },
  {
    name: "the persistent instance holds the volume: lower the group (no interruption)",
    desired: awake(),
    o: { persistent: persistent("running"), group: groupLaunching },
    expect: { kind: "lower-fallback", why: "loser" },
  },
  // R2: a park stays parked.
  {
    name: "SIM-F1: user sleep inside the replacing window wins",
    desired: asleep(T0 - MIN),
    o: { interruption: { instanceId: P, at: T0 - 5 * MIN } },
    expect: { kind: "none", why: "parked" },
  },
  {
    name: "SIM-F1: a wake older than the EC2 stop does not open the replacing window",
    desired: awake(T0 - 3 * MIN),
    o: { interruption: { instanceId: P, at: T0 - 5 * MIN } },
    expect: { kind: "start-persistent", id: P },
  },
  {
    name: "SIM-F2: a tick that read the wake before the sleep acts on the sleep",
    desired: asleep(T0 - 10_000),
    o: { persistent: persistent("pending") },
    expect: { kind: "stop-persistent", id: P, why: "asleep" },
  },
  {
    name: "SIM-F3: a reclaim warning delivered after the sleep raises nothing",
    desired: asleep(T0 - 3 * MIN),
    o: { interruption: { instanceId: P, at: T0 - 4 * MIN } },
    expect: { kind: "none", why: "parked" },
  },
  {
    name: "SIM-F3: a warning about an earlier boot raises nothing",
    desired: awake(T0 - 60 * MIN),
    o: {
      persistent: persistent("running", { launchedAt: T0 - 2 * MIN }),
      interruption: { instanceId: P, at: T0 - 5 * MIN },
    },
    expect: { kind: "none", why: "awake" },
  },
  {
    name: "SIM-F5: a started instance that is still pending never gets a group beside it",
    desired: awake(T0 - 30_000),
    o: { persistent: persistent("pending", { launchedAt: T0 - 20_000 }) },
    expect: { kind: "none", why: "awake" },
  },
  {
    name: "SIM-F8: a sleep that stopped nothing still lowers a group waiting for Spot",
    desired: asleep(),
    o: { group: groupLaunching },
    expect: { kind: "lower-fallback", why: "asleep" },
  },
  {
    name: "asleep while the instance is stopping: wait",
    desired: asleep(),
    o: { persistent: persistent("stopping") },
    expect: { kind: "wait", why: "stopping", recheckInMs: 30_000 },
  },
  {
    name: "a park in progress blocks a start",
    desired: awake(T0 - 10_000),
    o: { sleepFence: { at: T0 - MIN, phase: "before-stop" } },
    expect: { kind: "wait", why: "park-in-progress", recheckInMs: 30_000 },
  },
  {
    name: "a finished park does not block a newer wake",
    desired: awake(T0 - 10_000),
    o: { sleepFence: { at: T0 - MIN, phase: "after-stop" } },
    expect: { kind: "start-persistent", id: P },
  },
  {
    name: "a fence older than 10 min does not block",
    desired: awake(T0 - 10_000),
    o: { sleepFence: { at: T0 - 11 * MIN, phase: "before-stop" } },
    expect: { kind: "start-persistent", id: P },
  },
  // Freeze.
  {
    name: "frozen and running: stop",
    desired: awake(),
    o: { frozen: true, persistent: persistent("running") },
    expect: { kind: "stop-persistent", id: P, why: "frozen" },
  },
  {
    name: "frozen, group up: lower",
    desired: awake(),
    o: { frozen: true, group: groupLaunching },
    expect: { kind: "lower-fallback", why: "frozen" },
  },
  {
    name: "frozen, nothing up: nothing",
    desired: awake(),
    o: { frozen: true },
    expect: { kind: "none", why: "frozen" },
  },
];

for (const row of rows) {
  test(`decideReconcile: ${row.name}`, () => {
    assert.deepEqual(decideReconcile(row.desired, { ...base, ...row.o }), row.expect);
  });
}

const STATES: ReadonlyArray<Ec2State | null> = [
  null,
  "pending",
  "running",
  "stopping",
  "stopped",
  "shutting-down",
  "terminated",
];
const BILLING = new Set(["start-persistent", "raise-fallback"]);

test("decideReconcile safety over every combination of observed facts", () => {
  let checked = 0;
  for (const state of STATES)
    for (const groupState of [null, "none", "launching", "up"] as const)
      for (const holder of [null, P, G] as const)
        for (const fence of [null, "before-stop", "after-stop"] as const)
          for (const interrupted of [false, true])
            for (const frozen of [false, true])
              for (const want of ["awake", "asleep"] as const) {
                const desired = want === "awake" ? awake(T0 - 30 * MIN) : asleep(T0 - 30_000);
                const o: Observed = {
                  ...base,
                  frozen,
                  persistent: state === null ? null : persistent(state),
                  group:
                    groupState === null
                      ? null
                      : groupState === "none"
                        ? { desired: 0, instances: [] }
                        : groupState === "up"
                          ? groupUp
                          : groupLaunching,
                  volume: { id: "vol-1", attachedTo: holder, active: true },
                  sleepFence: fence === null ? null : { at: T0 - MIN, phase: fence },
                  interruption: interrupted ? { instanceId: P, at: T0 - 2 * MIN } : null,
                };
                const a = decideReconcile(desired, o);
                const what = JSON.stringify({ state, groupState, holder, fence, interrupted, frozen, want, a });
                checked += 1;
                // R2: a park stays parked; a freeze and a park in progress start nothing.
                if (want === "asleep" || frozen || fence === "before-stop") assert.ok(!BILLING.has(a.kind), what);
                if (want === "asleep") assert.notEqual(a.kind, "release-volume", what);
                // Never a second writer: no start while the group's instance holds the volume.
                if (holder === G && groupState === "up") assert.notEqual(a.kind, "start-persistent", what);
                // The volume moves only from a stopped instance.
                if (a.kind === "release-volume") assert.equal(state, "stopped", what);
                // A live persistent instance gets a group beside it only as a reclaim successor.
                if (a.kind === "raise-fallback" && (state === "pending" || state === "running"))
                  assert.ok(interrupted, what);
                // While awake, the persistent instance is stopped only as the loser of the volume, or by the freeze.
                if (a.kind === "stop-persistent" && want === "awake") assert.ok(frozen || holder === G, what);
              }
  assert.equal(checked, STATES.length * 4 * 3 * 3 * 2 * 2 * 2);
});

const afterStop = (at: number, reason = "user") => ({ sleepFence: { at, phase: "after-stop" as const, reason } });
const observed = (over: Partial<Observed>): Observed => ({ ...base, ...over });

test("agentPark: the agent's own park (after-stop fence) becomes desired asleep at the fence time (R2)", () => {
  const fence = afterStop;
  const o = observed;
  assert.deepEqual(agentPark(awake(T0 - 10 * MIN), o(fence(T0 - MIN))), {
    want: "asleep",
    since: T0 - MIN,
    reason: "park:agent:user",
    origin: "auto",
  });
  assert.equal(agentPark(asleep(), o(fence(T0 - MIN))), null, "already asleep");
  assert.equal(agentPark(awake(T0), o(fence(T0 - MIN))), null, "a wake after the park wins");
  assert.equal(
    agentPark(
      awake(T0 - 10 * MIN),
      o({ ...fence(T0 - 3 * MIN), persistent: persistent("running", { launchedAt: T0 - MIN }) }),
    ),
    null,
    "a boot after the fence",
  );
  assert.equal(agentPark(awake(T0 - 10 * MIN), o(fence(T0 - MIN, "reclaim"))), null, "a Spot reclaim is not a park");
  assert.equal(
    agentPark(awake(T0 - 10 * MIN), o({ sleepFence: { at: T0 - MIN, phase: "before-stop", reason: "idle" } })),
    null,
    "still parking",
  );
});
