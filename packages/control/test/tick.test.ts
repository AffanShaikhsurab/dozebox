// C3: the tick over FakeAws. Wake -> start, park -> stop and stays parked (R2), one action per tick, ReconcileSkipped
// without the lease; act re-reads before acting and skips when the fence appeared, desired flipped or the instance
// moved; tokens derive from the intent, not the clock; the awake cap parks.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { decideReconcile } from "@dozebox/core/reconcile";
import { makeFakeAlertSink } from "@dozebox/testkit/fakes";
import { act } from "../src/reconcile/act.ts";
import { observe } from "../src/reconcile/observe.ts";
import { tick } from "../src/reconcile/tick.ts";
import { actionToken } from "../src/state/idempotency.ts";
import { desiredOrder } from "../src/state/keys.ts";
import { makeWorld, type World } from "./fixture.ts";

const MIN = 60_000;
const actions = (w: World) => w.computeCalls.filter((c) => !c.op.startsWith("describe"));

function boxWith(state: "running" | "stopped", config = {}) {
  const w = makeWorld({ config });
  const id = w.aws.ec2.addMachine({ boxId: "main", role: "persistent", state, lifecycle: "spot" });
  return { w, id };
}

async function fence(w: World, id: string, at: number) {
  const record = {
    v: 1,
    at: new Date(at).toISOString(),
    writer: { instanceId: id, bootId: "boot-0001" },
    reason: "user",
    phase: "before-stop",
  };
  await w.deps.records.put("fence/sleep-requested", JSON.stringify(record), { tier: "Standard" });
}

async function held(w: World) {
  const lease = await w.deps.leases.acquire("reconcile");
  assert.ok(lease !== null);
  return lease;
}

describe("tick", () => {
  test("a wake is started by the next tick with the intent's token", async () => {
    const { w, id } = boxWith("stopped");
    await w.call("POST", "/v1/wake");
    const r = await tick(w.deps, { trigger: "schedule" });
    const desired = await w.deps.desired.read();
    const token = actionToken("main", String(desiredOrder(desired)), 0);
    assert.deepEqual(r, { kind: "done", outcome: { kind: "acted", action: "start-persistent", token } });
    assert.deepEqual(w.aws.ec2.calls, [{ op: "start", id, token }]);
    assert.ok(w.lines.some((l) => l.includes('"ReconcileCompleted":1')));
  });

  test("a park stops the instance and stays parked for three more ticks (R2)", async () => {
    const { w, id } = boxWith("running");
    await w.call("POST", "/v1/park");
    await tick(w.deps, { trigger: "schedule" });
    for (let i = 0; i < 3; i++) {
      w.aws.clock.advance(MIN);
      await tick(w.deps, { trigger: "schedule" });
    }
    assert.deepEqual(
      w.aws.ec2.calls.map((c) => [c.op, c.id]),
      [["stop", id]],
    );
    assert.equal(w.aws.ec2.machine(id)?.state, "stopped");
  });

  test("one action per tick", async () => {
    const { w } = boxWith("stopped");
    await w.call("POST", "/v1/wake");
    for (let i = 0; i < 5; i++) {
      const before = actions(w).length;
      await tick(w.deps, { trigger: "schedule" });
      assert.ok(actions(w).length - before <= 1);
      w.aws.clock.advance(MIN);
    }
  });

  test("ReconcileSkipped and no action when another holder has the lease", async () => {
    const { w } = boxWith("stopped");
    await w.call("POST", "/v1/wake");
    await w.aws.dynamodb.table.acquireLease("reconcile", "someone-else", 45_000, w.aws.clock.now());
    assert.deepEqual(await tick(w.deps, { trigger: "schedule" }), { kind: "skipped" });
    assert.deepEqual(actions(w), []);
    assert.ok(w.lines.some((l) => l.includes('"ReconcileSkipped":1')));
  });

  test("a capacity refusal is recorded and the next tick raises the fallback group", async () => {
    const { w } = boxWith("stopped", {
      groups: { spot: null, fallback: "dozebox-main-fallback" },
      fallback: { enabled: true, unattended: false },
    });
    w.aws.asg.addGroup("dozebox-main-fallback", { boxId: "main", lifecycle: "on-demand" });
    w.aws.ec2.setSpotCapacity(false);
    await w.call("POST", "/v1/wake");
    const first = await tick(w.deps, { trigger: "schedule" });
    assert.deepEqual(first.kind === "done" && first.outcome, {
      kind: "skipped",
      action: "start-persistent",
      why: "start-error:capacity",
    });
    w.aws.clock.advance(MIN);
    const second = await tick(w.deps, { trigger: "schedule" });
    assert.equal(second.kind === "done" && second.outcome.kind === "acted" && second.outcome.action, "raise-fallback");
  });

  test("the awake cap parks the box (reason park:cap) and the next tick stops it", async () => {
    const { w, id } = boxWith("stopped", {
      caps: { awakeHoursPerDay: 1, onDemandHoursPerDay: null, monthlyBudgetUsd: 60, budgetName: "b" },
    });
    await w.call("POST", "/v1/wake");
    for (let i = 0; i < 64 && (await w.deps.desired.read()).want === "awake"; i++) {
      await tick(w.deps, { trigger: "schedule" });
      w.aws.clock.advance(MIN);
    }
    const desired = await w.deps.desired.read();
    assert.deepEqual([desired.want, desired.reason, desired.origin], ["asleep", "park:cap:awake-24h", "judge"]);
    await tick(w.deps, { trigger: "schedule" });
    assert.deepEqual(w.aws.ec2.calls.at(-1)?.op, "stop");
    assert.equal(w.aws.ec2.calls.at(-1)?.id, id);
  });

  test("spend at the budget freezes the box once, pages, and the next tick stops it", async () => {
    const ntfy = makeFakeAlertSink("ntfy");
    const w = makeWorld({ sinks: [ntfy, makeFakeAlertSink("email")] });
    const id = w.aws.ec2.addMachine({ boxId: "main", role: "persistent", state: "running", lifecycle: "spot" });
    await w.call("POST", "/v1/wake");
    w.aws.budgets.setMonthToDate({ usd: 61, asOf: w.aws.clock.now() });
    await tick(w.deps, { trigger: "schedule" });
    w.aws.clock.advance(MIN);
    await tick(w.deps, { trigger: "schedule" });
    assert.equal(JSON.parse((await w.deps.records.get("freeze"))?.value ?? "{}").by, "budget");
    assert.deepEqual(
      ntfy.delivered.map((a) => a.key),
      ["budget-freeze"],
    );
    assert.deepEqual(w.aws.ec2.calls.at(-1), { op: "stop", id, token: w.aws.ec2.calls.at(-1)?.token });
  });

  test("a wake that never serves is paged through the outbox by the tick, once", async () => {
    const ntfy = makeFakeAlertSink("ntfy");
    const w = makeWorld({ sinks: [ntfy, makeFakeAlertSink("email")] });
    w.aws.ec2.addMachine({ boxId: "main", role: "persistent", state: "stopped", lifecycle: "spot" });
    await w.call("POST", "/v1/wake");
    for (let i = 0; i < 20; i++) {
      await tick(w.deps, { trigger: "schedule" });
      w.aws.clock.advance(MIN);
    }
    assert.deepEqual(
      ntfy.delivered.map((a) => a.key),
      ["wake-unresolved"],
    );
  });

  test("fallback hand-off: once the group is up, the stopped persistent instance releases the volume", async () => {
    const { w, id } = boxWith("stopped", {
      groups: { spot: null, fallback: "dozebox-main-fallback" },
      fallback: { enabled: true, unattended: false },
    });
    w.aws.asg.addGroup("dozebox-main-fallback", { boxId: "main", lifecycle: "on-demand" });
    const vol = w.aws.ebs.addVolume({ boxId: "main", active: true });
    await w.aws.ebs.attach.attach({ boxId: "main", volumeId: vol, machineId: id, device: "/dev/sdf" });
    w.aws.ec2.setSpotCapacity(false);
    await w.call("POST", "/v1/wake");
    const done: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await tick(w.deps, { trigger: "schedule" });
      if (r.kind === "done" && r.outcome.kind === "acted") done.push(r.outcome.action);
      w.aws.clock.advance(MIN);
    }
    assert.deepEqual(done, ["raise-fallback", "release-volume"]);
    assert.equal((await w.aws.ebs.attach.describe(vol))?.attachment, null);
  });

  test("the tick runs the weekly restore test: scratch volume from the newest snapshot, verified, deleted", async () => {
    const { w } = boxWith("stopped");
    const live = w.aws.ebs.addVolume({ boxId: "main", active: true });
    const snap = w.aws.ebs.addSnapshot({ boxId: "main" });
    await tick(w.deps, { trigger: "schedule" });
    const scratch = (await w.deps.volumes.describeBox("main")).filter((v) => v.id !== live);
    assert.deepEqual(
      scratch.map((v) => v.active),
      [false],
    );
    w.aws.clock.advance(16 * MIN);
    await tick(w.deps, { trigger: "schedule" });
    assert.deepEqual(
      (await w.deps.volumes.describeBox("main")).map((v) => v.id),
      [live],
    );
    assert.deepEqual(await w.deps.state.get("restore-test"), {
      phase: "idle",
      lastResult: { at: w.aws.clock.now(), ok: true, snapshotId: snap, detail: "restored 8 GiB, available" },
    });
  });
});

describe("act re-reads before destructive and billing actions", () => {
  test("a sleep fence that appeared after the snapshot skips the start", async () => {
    const { w, id } = boxWith("stopped");
    await w.call("POST", "/v1/wake");
    const snapshot = await observe(w.deps, w.aws.clock.now());
    await fence(w, id, w.aws.clock.now());
    const out = await act(w.deps, decideReconcile(snapshot.desired, snapshot.observed), {
      lease: await held(w),
      snapshot,
    });
    assert.deepEqual(out, { kind: "skipped", action: "start-persistent", why: "fence-appeared" });
    assert.deepEqual(actions(w), []);
  });

  test("a desired state that flipped after the snapshot skips the start and the stop", async () => {
    const { w } = boxWith("stopped");
    await w.call("POST", "/v1/wake");
    const snapshot = await observe(w.deps, w.aws.clock.now());
    w.aws.clock.advance(1_000);
    await w.call("POST", "/v1/park");
    const out = await act(w.deps, decideReconcile(snapshot.desired, snapshot.observed), {
      lease: await held(w),
      snapshot,
    });
    assert.equal(out.kind === "skipped" && out.why, "desired-changed");

    const r = boxWith("running");
    await r.w.call("POST", "/v1/park");
    const parked = await observe(r.w.deps, r.w.aws.clock.now());
    r.w.aws.clock.advance(1_000);
    await r.w.call("POST", "/v1/wake");
    const stop = await act(r.w.deps, decideReconcile(parked.desired, parked.observed), {
      lease: await held(r.w),
      snapshot: parked,
    });
    assert.equal(stop.kind === "skipped" && stop.why, "desired-changed");
    assert.deepEqual(actions(w), []);
    assert.deepEqual(actions(r.w), []);
  });

  test("an instance whose state moved since the snapshot is not acted on", async () => {
    const { w, id } = boxWith("stopped");
    await w.call("POST", "/v1/wake");
    const snapshot = await observe(w.deps, w.aws.clock.now());
    await w.aws.ec2.compute.startPersistent(id, "someone-else");
    const before = actions(w).length;
    const out = await act(w.deps, { kind: "start-persistent", id }, { lease: await held(w), snapshot });
    assert.deepEqual(out, { kind: "skipped", action: "start-persistent", why: "state-changed" });
    assert.equal(actions(w).length, before);
  });

  test("the token is the same for the same intent, at any time", async () => {
    const { w } = boxWith("stopped");
    await w.call("POST", "/v1/wake");
    const a = await observe(w.deps, w.aws.clock.now());
    w.aws.clock.advance(10 * MIN);
    const b = await observe(w.deps, w.aws.clock.now());
    const t = (s: typeof a) => actionToken("main", String(desiredOrder(s.desired)), 0);
    assert.equal(t(a), t(b));
  });
});
