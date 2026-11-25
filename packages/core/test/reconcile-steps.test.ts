// Rows ported from legacy/runner/test/control/persistent.node-test.ts (decideWake -> decideStart, decideReconcile ->
// decideSteps). The full legacy tables run against these modules through legacy/runner/control/core.mjs.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseStoppedAt, type Snapshot } from "../src/reconcile/facts.ts";
import { nextAfterSpotMiss, readLaunch, readLaunchError } from "../src/reconcile/launch.ts";
import { hasInterruptedIntent, pickPersistent, wakeCancelled } from "../src/reconcile/model.ts";
import { decideStart } from "../src/reconcile/start.ts";
import { decideSteps, type Step } from "../src/reconcile/steps.ts";

const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const MIN = 60_000;
const ago = (minutes: number) => new Date(T0 - minutes * MIN).toISOString();
const gmt = (iso: string) => iso.slice(0, 19).replace("T", " ");
const PID = "i-persistent";
const AID = "i-asg";

const persistent = (over: Record<string, unknown> = {}) => ({
  id: PID,
  state: "stopped",
  launchedAt: ago(120),
  stateReasonCode: "Client.UserInitiatedShutdown",
  stateTransitionReason: `User initiated (${gmt(ago(60))} GMT)`,
  ...over,
});
const running = (over: Record<string, unknown> = {}) =>
  persistent({ state: "running", launchedAt: ago(30), stateReasonCode: null, stateTransitionReason: "", ...over });
const interrupted = () =>
  persistent({ stateReasonCode: "Server.SpotInstanceShutdown", stateTransitionReason: "Server.SpotInstanceShutdown" });
const parkedAsg = (over: Record<string, unknown> = {}) => ({ desired: 0, state: "parked", since: ago(1000), ...over });
const asgRunning = { desired: 1, state: "running", since: ago(5), instance: { id: AID, launchedAt: ago(5) } };
const volumeOn = (attachedTo: string | null) => ({ id: "vol-1", attachedTo });
const snap = (over: Record<string, unknown> = {}): Snapshot => ({
  persistent: persistent(),
  spotRequest: { state: "disabled", statusCode: "instance-stopped-by-user", statusUpdatedAt: ago(58) },
  asgStatus: parkedAsg(),
  volume: volumeOn(PID),
  intent: null,
  serving: null,
  nowMs: T0,
  ...over,
});
const refusal = (name = "IncorrectSpotRequestState") => Object.assign(new Error("refused"), { name });

const startRows: ReadonlyArray<{ name: string; over: Record<string, unknown>; expect: unknown }> = [
  { name: "a stopped instance is started", over: {}, expect: { action: "start" } },
  { name: "running -> none", over: { persistent: running() }, expect: { action: "none" } },
  { name: "pending -> none", over: { persistent: persistent({ state: "pending" }) }, expect: { action: "none" } },
  { name: "group instance live -> none", over: { asgLive: true }, expect: { action: "none" } },
  {
    name: "group desired with no instance yet -> none",
    over: { asgStatus: { desired: 1, state: "launching" } },
    expect: { action: "none" },
  },
  { name: "stopping -> wait", over: { persistent: persistent({ state: "stopping" }) }, expect: { action: "wait" } },
  {
    name: "recently interrupted -> fallback",
    over: {
      persistent: interrupted(),
      spotRequest: { state: "disabled", statusCode: "instance-stopped-no-capacity", statusUpdatedAt: ago(2) },
    },
    expect: { action: "fallback", reason: "interrupted" },
  },
  {
    name: "interrupted 10 min ago with the volume on it -> start",
    over: {
      persistent: interrupted(),
      spotRequest: { state: "disabled", statusCode: "instance-stopped-no-capacity", statusUpdatedAt: ago(10) },
    },
    expect: { action: "start" },
  },
  {
    name: "interrupted long ago but another holds the volume -> fallback",
    over: {
      persistent: interrupted(),
      spotRequest: { state: "disabled", statusCode: "instance-stopped-no-capacity", statusUpdatedAt: ago(300) },
      volume: volumeOn(AID),
    },
    expect: { action: "fallback", reason: "interrupted" },
  },
  {
    name: "refused just after the stop -> wait",
    over: {
      persistent: persistent({ stateTransitionReason: `User initiated (${gmt(ago(1))} GMT)` }),
      startError: refusal(),
    },
    expect: { action: "wait" },
  },
  {
    name: "refused long after the stop -> fallback refused",
    over: { startError: refusal() },
    expect: { action: "fallback", reason: "refused" },
  },
  {
    name: "capacity -> fallback capacity",
    over: { startError: refusal("InsufficientInstanceCapacity") },
    expect: { action: "fallback", reason: "capacity" },
  },
  {
    name: "capacity in the message -> fallback capacity",
    over: { startError: new Error("We currently do not have sufficient capacity") },
    expect: { action: "fallback", reason: "capacity" },
  },
  {
    name: "IncorrectInstanceState -> wait",
    over: { startError: refusal("IncorrectInstanceState") },
    expect: { action: "wait" },
  },
  {
    name: "other error -> fallback start-failed",
    over: { startError: refusal("UnauthorizedOperation") },
    expect: { action: "fallback", reason: "start-failed" },
  },
  {
    name: "shutting-down -> fallback start-failed",
    over: { persistent: persistent({ state: "shutting-down" }) },
    expect: { action: "fallback", reason: "start-failed" },
  },
  {
    name: "no persistent instance -> fallback absent",
    over: { persistent: null },
    expect: { action: "fallback", reason: "absent" },
  },
  {
    name: "request active with a stop in flight -> wait or refused",
    over: { spotRequest: { state: "active", statusCode: "marked-for-stop", statusUpdatedAt: ago(10) } },
    expect: { action: "fallback", reason: "refused" },
  },
];

for (const row of startRows) {
  test(`decideStart: ${row.name}`, () => assert.deepEqual(decideStart(snap(row.over)), row.expect));
}

const asgState = (over: Record<string, unknown> = {}) => ({ desired: 0, onDemandPercent: 0, instances: [], ...over });
const asgInstance = (lifecycleState = "InService", id = AID) => ({ id, lifecycleState });
const reconcileSnap = (over: Record<string, unknown> = {}): Snapshot =>
  snap({
    persistent: undefined,
    persistents: [persistent()],
    asg: asgState(),
    nextWakeAt: null,
    asgLastLaunchAt: null,
    ...over,
  });
const deps = { persistentState: () => "parked" };
const names = (steps: Step[]) => steps.map((s) => s.action);

const stepRows: ReadonlyArray<{ name: string; over: Record<string, unknown>; expect: string[] }> = [
  { name: "nothing to do while parked", over: {}, expect: [] },
  {
    name: "the group instance holds the volume: stop the persistent one",
    over: {
      persistents: [running()],
      asg: asgState({ desired: 1, instances: [asgInstance()] }),
      asgStatus: asgRunning,
      volume: volumeOn(AID),
    },
    expect: ["stop-loser-persistent"],
  },
  {
    name: "the persistent instance holds the volume: park the fallback",
    over: {
      persistents: [running()],
      asg: asgState({ desired: 1, instances: [asgInstance("Pending")] }),
      asgStatus: asgRunning,
    },
    expect: ["park-loser-fallback"],
  },
  {
    name: "a successor launched for a warning is left alone",
    over: {
      persistents: [running()],
      asg: asgState({ desired: 1 }),
      asgStatus: { desired: 1, state: "launching", since: ago(1) },
      intent: { at: ago(1), fallbackReason: "interrupted" },
    },
    expect: [],
  },
  {
    name: "the warned instance stopped: free the volume for the successor",
    over: {
      asg: asgState({ desired: 1 }),
      asgStatus: { desired: 1, state: "launching" },
      intent: { at: ago(1), fallbackReason: "interrupted" },
    },
    expect: ["fallback"],
  },
  {
    name: "a fresh wake intent while parked: wake",
    over: { intent: { at: ago(1), fallbackReason: null } },
    expect: ["wake"],
  },
  {
    name: "an intent older than the stop: nothing",
    over: { intent: { at: ago(61), fallbackReason: null } },
    expect: [],
  },
  {
    name: "an intent older than a sleep fence: nothing (R2)",
    over: { intent: { at: ago(2), fallbackReason: null }, sleepFenceMs: T0 - MIN },
    expect: [],
  },
  { name: "scheduled wake due: wake", over: { nextWakeAt: T0 }, expect: ["wake"] },
  {
    name: "scheduled wake already woken: skip",
    over: { nextWakeAt: T0, asgLastLaunchAt: ago(0.5) },
    expect: ["wake-skipped-already-woken"],
  },
  {
    name: "two live persistent instances: stop the duplicate",
    over: { persistents: [running(), running({ id: "i-dup", launchedAt: ago(10) })] },
    expect: ["persistent-duplicate"],
  },
  {
    name: "group on On-Demand while parked: reset",
    over: { asg: asgState({ onDemandPercent: 100 }) },
    expect: ["on-demand-reset"],
  },
  {
    name: "group waiting for capacity: On-Demand fallback",
    over: {
      asg: asgState({ desired: 1 }),
      asgStatus: { desired: 1, state: "waiting-capacity" },
      volume: volumeOn(null),
    },
    expect: ["on-demand-fallback"],
  },
];

for (const row of stepRows) {
  test(`decideSteps: ${row.name}`, () =>
    assert.deepEqual(names(decideSteps(reconcileSnap(row.over), deps)), row.expect));
}

test("decideSteps: a box that parked with an error is not woken by the schedule", () => {
  assert.deepEqual(names(decideSteps(reconcileSnap({ nextWakeAt: T0 }), { persistentState: () => "stopped-error" })), [
    "wake-skipped-error",
  ]);
});

test("model helpers: pickPersistent, hasInterruptedIntent, wakeCancelled, parseStoppedAt", () => {
  assert.equal(pickPersistent([]), null);
  assert.equal(pickPersistent([persistent(), running({ id: "i-up" })])?.id, "i-up");
  assert.equal(pickPersistent([running({ id: "i-up" }), persistent()], volumeOn(PID))?.id, PID);
  const intent = { at: ago(1), fallbackReason: "interrupted" };
  assert.equal(hasInterruptedIntent({ intent, persistent: persistent(), nowMs: T0 }), true);
  assert.equal(hasInterruptedIntent({ intent, persistent: persistent(), nowMs: T0, parkedMs: T0 }), false);
  assert.equal(hasInterruptedIntent({ intent, persistent: persistent(), nowMs: T0 + 20 * MIN }), false);
  assert.equal(wakeCancelled(snap({ sleepFenceMs: T0 }), { at: ago(1), fallbackReason: null }), true);
  assert.equal(wakeCancelled(snap({ persistent: running() }), { at: ago(1), fallbackReason: null }), false);
  assert.equal(parseStoppedAt("User initiated (2026-11-12 09:23:07 GMT)"), "2026-11-12T09:23:07.000Z");
  assert.equal(parseStoppedAt("Server.SpotInstanceShutdown"), null);
});

test("launch readers", () => {
  assert.equal(readLaunch({ instances: [{ id: AID }] }).outcome, "launched");
  assert.equal(readLaunch({ errors: [{ code: "InsufficientInstanceCapacity" }] }).outcome, "capacity");
  assert.equal(readLaunch({ errors: [{ code: "SpotMaxPriceTooLow" }] }).outcome, "price");
  assert.equal(readLaunch({ errors: [{ code: "VcpuLimitExceeded" }] }).outcome, "quota");
  assert.equal(readLaunch(null).outcome, "failed");
  assert.equal(readLaunchError({ name: "ValidationError", message: "exceeds the Maximum Size" }), "full");
  assert.equal(readLaunchError({ name: "IdempotentCallInProgress" }), "in-progress");
  assert.equal(readLaunchError({ name: "ScalingActivityInProgress" }), "busy");
  assert.equal(readLaunchError({ name: "LaunchInstancesUnavailable" }), "unavailable");
  assert.equal(readLaunchError("boom"), "error");
  assert.equal(nextAfterSpotMiss({ outcome: "capacity", origin: "user", onDemandAllowed: true }), "on-demand");
  assert.equal(nextAfterSpotMiss({ outcome: "capacity", origin: "schedule", onDemandAllowed: true }), "wait");
  assert.equal(nextAfterSpotMiss({ outcome: "quota", origin: "user", onDemandAllowed: true }), "failed");
});
