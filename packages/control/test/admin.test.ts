// Admin events from the CLI (CR-cli-1, CR-cli-4): park, status with records, swap-volume, and the refusals.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeHandler } from "../src/handler.ts";
import { runAdmin } from "../src/admin/run.ts";
import { makeLeaseKeeper } from "../src/state/lease.ts";
import { makeWorld, type World } from "./fixture.ts";

const admin = (action: string, extra: Readonly<Record<string, unknown>> = {}) => ({
  dozebox: "admin",
  v: 1,
  action,
  ...extra,
});

async function refused(p: Promise<unknown>, code: string, text: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof RunnerError && e.code === code && text.test(e.message));
}

const parkedWorld = (): World => {
  const w = makeWorld();
  w.aws.ec2.addMachine({ boxId: "main", role: "persistent", state: "stopped", lifecycle: "spot" });
  return w;
};

describe("admin park", () => {
  test("writes desired asleep with origin operator and the next tick stops the instance", async () => {
    const w = makeWorld();
    w.aws.ec2.addMachine({ boxId: "main", role: "persistent", state: "running", lifecycle: "spot" });
    await w.call("POST", "/v1/wake");
    const out = await runAdmin(w.deps, admin("park", { force: true, reason: "restore" }));
    assert.equal((out as { decision?: unknown }).decision, "accept");
    assert.equal((out as { desired?: unknown }).desired, "asleep");
    const d = await w.deps.desired.read();
    assert.deepEqual([d.want, d.origin, d.reason], ["asleep", "operator", "park:restore"]);
    assert.equal(w.aws.ec2.calls.length, 0);
    const { tick } = await import("../src/reconcile/tick.ts");
    await tick(w.deps, { trigger: "schedule" });
    assert.deepEqual(
      w.aws.ec2.calls.map((c) => c.op),
      ["stop"],
    );
  });
});

describe("admin status", () => {
  test("records: true lists rec/* records with at and writer; false adds none", async () => {
    const w = parkedWorld();
    const writer = { instanceId: "i-1", bootId: "b-1" };
    await w.deps.records.put("rec/serving", JSON.stringify({ v: 1, at: "2026-11-25T00:00:05Z", writer }), {
      tier: "Standard",
    });
    await w.deps.records.put("rec/odd", "not json", { tier: "Standard" });
    const plain = await runAdmin(w.deps, admin("status", { records: false }));
    assert.equal("records" in plain, false);
    const withRecords = (await runAdmin(w.deps, admin("status", { records: true }))) as {
      state?: unknown;
      records?: ReadonlyArray<{ key: string; at: string; writer: unknown }>;
    };
    assert.equal(withRecords.state, "parked");
    const rows = withRecords.records ?? [];
    assert.deepEqual(
      rows.find((r) => r.key === "rec/serving"),
      { key: "rec/serving", at: "2026-11-25T00:00:05Z", writer },
    );
    const odd = rows.find((r) => r.key === "rec/odd");
    assert.equal(odd?.writer, null);
    assert.match(odd?.at ?? "", /^\d{4}-\d\d-\d\dT/);
  });
});

const setup = () => {
  const w = parkedWorld();
  const a = w.aws.ebs.addVolume({ boxId: "main", active: true });
  const b = w.aws.ebs.addVolume({ boxId: "main", active: false });
  return { w, a, b };
};
const swap = (w: World, volumeId: string) => runAdmin(w.deps, admin("swap-volume", { volumeId, reason: "restore" }));

describe("admin swap-volume", () => {
  test("moves the active tag when parked", async () => {
    const { w, a, b } = setup();
    await w.call("POST", "/v1/park");
    assert.deepEqual(await swap(w, b), { ok: true, active: b, previous: a });
    assert.equal(w.aws.ebs.tagsOf(a)?.get("dozebox:active"), "false");
    assert.equal(w.aws.ebs.tagsOf(b)?.get("dozebox:active"), "true");
  });

  test("is a no-op when the volume is already active", async () => {
    const { w, a } = setup();
    await w.call("POST", "/v1/park");
    assert.deepEqual(await swap(w, a), { ok: true, active: a, previous: a });
  });

  test("refuses while the box is awake", async () => {
    const { w, b } = setup();
    await w.call("POST", "/v1/wake");
    await refused(swap(w, b), "invalid_input", /park first/);
    // Parked on paper, but the instance has not stopped yet.
    const running = makeWorld();
    running.aws.ec2.addMachine({ boxId: "main", role: "persistent", state: "running", lifecycle: "spot" });
    const v = running.aws.ebs.addVolume({ boxId: "main", active: false });
    await running.call("POST", "/v1/park");
    await refused(swap(running, v), "invalid_input", /park first/);
  });

  test("refuses another box's volume, an unknown one and an attached one", async () => {
    const { w, a, b } = setup();
    await w.call("POST", "/v1/park");
    const other = w.aws.ebs.addVolume({ boxId: "other", active: true });
    await refused(swap(w, other), "invalid_input", /not a volume of box main/);
    await refused(swap(w, "vol-nope"), "invalid_input", /not a volume/);
    const m = w.aws.ec2.addMachine({ boxId: "main", role: "persistent", state: "stopped", lifecycle: "spot" });
    await w.aws.ebs.attach.attach({ boxId: "main", volumeId: a, machineId: m, device: "/dev/sdf" });
    await refused(swap(w, b), "invalid_input", /still attached/);
  });

  test("refuses when another holder has the lease (retryable)", async () => {
    const { w, b } = setup();
    await w.call("POST", "/v1/park");
    const other = makeLeaseKeeper({ state: w.aws.dynamodb.table, clock: w.aws.clock, holder: "other" });
    assert.notEqual(await other.acquire("reconcile"), null);
    await assert.rejects(
      swap(w, b),
      (e: unknown) => e instanceof RunnerError && e.code === "aws_conflict" && e.retryable,
    );
  });
});

describe("admin refusals and routing", () => {
  test("rebuild, operator-hold, unknown actions and bad fields are invalid_input", async () => {
    const w = parkedWorld();
    await refused(runAdmin(w.deps, admin("rebuild", { reason: "x" })), "invalid_input", /terraform apply -replace/);
    await refused(
      runAdmin(w.deps, admin("operator-hold", { forSeconds: 60, reason: "x" })),
      "invalid_input",
      /operator-hold is not supported/,
    );
    await refused(runAdmin(w.deps, admin("explode")), "invalid_input", /unknown admin action/);
    await refused(runAdmin(w.deps, admin("park", { force: "yes", reason: "x" })), "invalid_input", /bad admin park/);
  });

  test("the handler routes the admin shape and logs the action", async () => {
    const w = parkedWorld();
    const out = await makeHandler(() => w.deps)(admin("status", { records: false }));
    assert.equal((out as { state?: unknown }).state, "parked");
    assert.ok(w.lines.some((l) => l.includes("admin action") && l.includes('"action":"status"')));
  });
});
