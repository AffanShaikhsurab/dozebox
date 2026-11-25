import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { controlStatusFixture, stackOutputsFixture, type FakeCliDeps } from "@dozebox/testkit/fakes";
import type { AdminEvent } from "dozebox";
import { EXIT } from "../src/command.ts";
import { fakeDeps, run } from "./harness.ts";

/** The control function's side of park and swap-volume, played on the fakes. */
function withControlSide(deps: FakeCliDeps, opts: { readonly startRunning?: boolean } = {}): FakeCliDeps {
  if (opts.startRunning === true) deps.control.current = controlStatusFixture({ state: "running", desired: "awake" });
  deps.control.onAdmin = (e: AdminEvent) => {
    if (e.action === "park") deps.control.current = controlStatusFixture();
    if (e.action === "swap-volume") {
      deps.aws.volumeList = deps.aws.volumeList.map((v) =>
        v.id === e.volumeId ? { ...v, active: true } : v.active ? { ...v, active: false, retired: true } : v,
      );
    }
    return { ok: true };
  };
  return deps;
}

function boxWithVolumes(): FakeCliDeps {
  const deps = withControlSide(fakeDeps(), { startRunning: true });
  deps.aws.volumeList.push(
    { id: "vol-a", zone: "us-east-1a", state: "in-use", active: true, retired: false },
    { id: "vol-old", zone: "us-east-1b", state: "available", active: false, retired: true },
  );
  deps.aws.snapshotList.push(
    { id: "snap-old", volumeId: "vol-a", state: "completed", startedAt: 1, label: "dlm" },
    { id: "snap-new", volumeId: "vol-a", state: "completed", startedAt: 2, label: "dlm" },
    { id: "snap-busy", volumeId: "vol-a", state: "pending", startedAt: 3, label: "dlm" },
  );
  return deps;
}

const activeIds = (deps: FakeCliDeps): ReadonlyArray<string> =>
  deps.aws.volumeList.filter((v) => v.active).map((v) => v.id);

describe("destroy", () => {
  it("snapshots every tagged volume (active and retired) before terraform destroy", async () => {
    const deps = boxWithVolumes();
    const r = await run(deps, ["destroy", "--yes"]);
    assert.equal(r.code, EXIT.ok, r.err.join(" "));
    const snapped = deps.aws.calls
      .filter((c) => c.op === "createSnapshot")
      .map((c) => (c.arg as { volumeId: string }).volumeId);
    assert.deepEqual(snapped, ["vol-a", "vol-old"]);
    const order = [
      ...deps.control.calls.map((c) => `control.${c.op}`),
      ...deps.terraform.calls.map((c) => `tf.${c.op}`),
    ];
    assert.ok(order.includes("tf.destroy"));
    // The park comes before any snapshot, and every snapshot exists before destroy ran.
    assert.equal((deps.control.calls.find((c) => c.op === "admin")?.arg as AdminEvent | undefined)?.action, "park");
    assert.equal(deps.aws.snapshotList.filter((s) => s.label === "pre-destroy").length, 2);
  });

  it("--no-keep-snapshots skips them; --json without --yes refuses before anything", async () => {
    const deps = boxWithVolumes();
    await run(deps, ["destroy", "--no-keep-snapshots", "--yes"]);
    assert.deepEqual(deps.aws.calls, []);
    const d2 = boxWithVolumes();
    const r = await run(d2, ["destroy", "--json"]);
    assert.equal(r.code, EXIT.usage);
    assert.deepEqual(
      d2.terraform.calls.filter((c) => c.op === "destroy"),
      [],
    );
  });

  it("a person saying no is exit 5 and nothing changes", async () => {
    const deps = boxWithVolumes();
    const no = { ...deps, prompt: { asked: [], confirm: async () => false, secret: async () => "" } };
    assert.equal((await run(no, ["destroy"])).code, EXIT.refused);
    assert.deepEqual(deps.aws.calls, []);
  });
});

describe("restore", () => {
  it("latest: parks, new volume in the active volume's zone, exactly one active afterwards", async () => {
    const deps = boxWithVolumes();
    const r = await run(deps, ["restore", "latest", "--yes", "--json"]);
    assert.equal(r.code, EXIT.ok, r.err.join(" "));
    const created = deps.aws.calls.find((c) => c.op === "createVolume")?.arg as { snapshotId: string; zone: string };
    assert.equal(created.snapshotId, "snap-new");
    assert.equal(created.zone, "us-east-1a");
    const out = r.json() as { volumeId: string; retired: string };
    assert.deepEqual(activeIds(deps), [out.volumeId]);
    assert.equal(out.retired, "vol-a");
    const admin = deps.control.calls.filter((c) => c.op === "admin").map((c) => (c.arg as AdminEvent).action);
    assert.deepEqual(admin, ["park", "swap-volume"]);
  });

  it("a control function that did not swap is a problem, not silent success", async () => {
    const deps = boxWithVolumes();
    deps.control.onAdmin = (e) => (e.action === "park" ? ((deps.control.current = controlStatusFixture()), {}) : {});
    const r = await run(deps, ["restore", "snap-old", "--yes"]);
    assert.equal(r.code, EXIT.problem);
    assert.match(r.err.join(""), /did not make vol-\S+ active/);
  });

  it("AZ: --az elsewhere is a move and says so; no active volume falls back to the instance zone", async () => {
    const deps = boxWithVolumes();
    const r = await run(deps, ["restore", "snap-new", "--az", "us-east-1c", "--yes"]);
    assert.equal(r.code, EXIT.ok);
    assert.ok(r.out.some((l) => /Moving the data volume to us-east-1c/.test(l)));
    const none = withControlSide(fakeDeps());
    none.control.current = controlStatusFixture({
      instance: {
        id: "i-1",
        type: "m7g.xlarge",
        az: "us-east-1d",
        launchedAt: "2026-11-25T00:00:00.000Z",
        lifecycle: "spot",
      },
    });
    none.aws.snapshotList.push({ id: "snap-x", volumeId: "vol-gone", state: "completed", startedAt: 1, label: null });
    assert.equal((await run(none, ["restore", "latest", "--yes"])).code, EXIT.ok);
    assert.equal(
      (none.aws.calls.find((c) => c.op === "createVolume")?.arg as { zone: string } | undefined)?.zone,
      "us-east-1d",
    );
    const nowhere = withControlSide(fakeDeps());
    nowhere.aws.snapshotList.push({
      id: "snap-x",
      volumeId: "vol-gone",
      state: "completed",
      startedAt: 1,
      label: null,
    });
    assert.equal((await run(nowhere, ["restore", "latest", "--yes"])).code, EXIT.usage);
  });

  it("refuses a pending snapshot, an unknown one and a bad zone", async () => {
    assert.equal((await run(boxWithVolumes(), ["restore", "snap-busy", "--yes"])).code, EXIT.refused);
    assert.equal((await run(boxWithVolumes(), ["restore", "snap-nope", "--yes"])).code, EXIT.usage);
    assert.equal((await run(boxWithVolumes(), ["restore", "latest", "--az", "mars", "--yes"])).code, EXIT.usage);
  });
});

describe("snapshots", () => {
  it("create snapshots the active volume and waits; delete confirms", async () => {
    const deps = boxWithVolumes();
    const r = await run(deps, ["snapshots", "create", "--label", "before-upgrade", "--json"]);
    assert.equal(r.code, EXIT.ok, r.err.join(" "));
    assert.deepEqual((r.json() as { volumeId: string; completed: boolean }).completed, true);
    assert.equal((deps.aws.calls[0]?.arg as { volumeId: string } | undefined)?.volumeId, "vol-a");
    assert.equal((await run(deps, ["snapshots", "delete", "snap-old", "--yes"])).code, EXIT.ok);
    assert.ok(!deps.aws.snapshotList.some((s) => s.id === "snap-old"));
    assert.equal((await run(deps, ["snapshots", "delete", "snap-zzz", "--yes"])).code, EXIT.usage);
  });

  it("`snapshots` alone lists its subcommands and exits 2", async () => {
    const r = await run(fakeDeps(), ["snapshots"]);
    assert.equal(r.code, EXIT.usage);
    assert.match(r.err.join("\n"), /snapshots list/);
  });
});

describe("volumes", () => {
  it("flags a box with no active volume (exit 1) and prints the fix", async () => {
    const deps = fakeDeps();
    deps.aws.volumeList.push({ id: "vol-r", zone: "us-east-1a", state: "available", active: false, retired: true });
    const r = await run(deps, ["volumes", "list"]);
    assert.equal(r.code, EXIT.problem);
    assert.ok(r.out.some((l) => l.includes("Fix: dozebox restore latest")));
    assert.equal((await run(boxWithVolumes(), ["volumes", "list"])).code, EXIT.ok);
  });

  it("retire refuses the active volume", async () => {
    const deps = boxWithVolumes();
    assert.equal((await run(deps, ["volumes", "retire", "vol-a", "--yes"])).code, EXIT.refused);
    deps.aws.volumeList.push({ id: "vol-c", zone: "us-east-1a", state: "available", active: false, retired: false });
    assert.equal((await run(deps, ["volumes", "retire", "vol-c", "--yes"])).code, EXIT.ok);
    assert.deepEqual(deps.aws.calls, [{ op: "retireVolume", arg: "vol-c" }]);
  });
});

describe("move-az", () => {
  it("snapshots the active volume and creates the new volume from that snapshot in the target zone", async () => {
    const deps = boxWithVolumes();
    const r = await run(deps, ["move-az", "us-east-1b", "--yes", "--json"]);
    assert.equal(r.code, EXIT.ok, r.err.join(" "));
    const snap = deps.aws.calls.find((c) => c.op === "createSnapshot")?.arg as { volumeId: string };
    assert.equal(snap.volumeId, "vol-a");
    const newest = deps.aws.snapshotList[0]?.id;
    const vol = deps.aws.calls.find((c) => c.op === "createVolume")?.arg as { snapshotId: string; zone: string };
    assert.deepEqual([vol.snapshotId, vol.zone], [newest, "us-east-1b"]);
    assert.deepEqual(activeIds(deps), [(r.json() as { volumeId: string }).volumeId]);
  });

  it("refuses the same zone and another region", async () => {
    assert.equal((await run(boxWithVolumes(), ["move-az", "us-east-1a", "--yes"])).code, EXIT.usage);
    assert.equal((await run(boxWithVolumes(), ["move-az", "eu-west-1a", "--yes"])).code, EXIT.usage);
  });
});

function unfreezeDeps(): FakeCliDeps {
  const deps = fakeDeps();
  deps.terraform.outputs = stackOutputsFixture({
    unfreeze_runbook: { document: "dozebox-main-unfreeze", parameters: { BoxRoleName: "dozebox-main-box" } },
  });
  deps.control.current = controlStatusFixture({ frozen: true });
  return deps;
}

describe("rebuild and unfreeze", () => {
  it("rebuild sends the admin rebuild event", async () => {
    const deps = fakeDeps();
    assert.equal((await run(deps, ["rebuild", "--yes"])).code, EXIT.ok);
    assert.deepEqual(deps.control.calls.at(-1), {
      op: "admin",
      arg: { action: "rebuild", reason: "operator rebuild" },
    });
  });

  it("unfreeze starts the runbook with the stack's parameters", async () => {
    const deps = unfreezeDeps();
    assert.equal((await run(deps, ["unfreeze", "--reason", "drill", "--yes"])).code, EXIT.ok);
    assert.deepEqual(deps.aws.calls, [
      {
        op: "startAutomation",
        arg: { document: "dozebox-main-unfreeze", params: { BoxRoleName: "dozebox-main-box" } },
      },
    ]);
  });

  it("unfreeze refuses without the operator role: the box role, or SSM AccessDenied", async () => {
    const box = unfreezeDeps();
    box.aws.caller = "arn:aws:sts::111122223333:assumed-role/dozebox-main-box/i-0abc";
    assert.equal((await run(box, ["unfreeze", "--reason", "x", "--yes"])).code, EXIT.refused);
    assert.deepEqual(box.aws.calls, []);
    const denied = unfreezeDeps();
    denied.aws.denied.add("startAutomation");
    const r = await run(denied, ["unfreeze", "--reason", "x", "--yes"]);
    assert.equal(r.code, EXIT.refused);
    assert.match(r.err.join(""), /operator role/);
    assert.equal((await run(unfreezeDeps(), ["unfreeze", "--yes"])).code, EXIT.usage);
  });
});
