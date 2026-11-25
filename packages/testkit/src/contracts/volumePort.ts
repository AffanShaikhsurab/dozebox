// The `volumePort` contracts: control's Volumes (describe, tag moves, create from snapshot), and the agent's
// VolumeAttach (find the active volume, attach behind the tag fence). Separate suites, because each package's wire
// tests may use only its own adapter.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import type { VolumeAttach } from "@dozebox/agent/ports/volumes";
import type { Volumes } from "@dozebox/control/ports/volumes";
import { fresh, gap, rejectsWith, type ContractOptions } from "./support.ts";

type Seeds = {
  /** The zone machines and volumes of this target live in. */
  readonly zone: string;
  /** A volume tagged to `boxId`; `active` sets `<prefix>:active=true`. */
  readonly seedVolume: (boxId: string, active: boolean) => Promise<string>;
};

export type VolumeHarness = Seeds & {
  readonly volumes: Volumes;
  /** A snapshot to create volumes from (on targets without snapshots, any id the target accepts). */
  readonly seedSnapshot: () => Promise<string>;
  readonly inject: (op: "describe" | "create", name: string, status: number) => void;
};

export type AttachHarness = Seeds & {
  readonly attach: VolumeAttach;
  /** A running machine in `zone`. Returns its id. */
  readonly seedMachine: () => Promise<string>;
  /** Wait until the volume's attachment to `machineId` reads `attached`. */
  readonly settleAttached: (volumeId: string, machineId: string) => Promise<void>;
  readonly inject: (op: "describe" | "attach", name: string, status: number) => void;
};

const activeOf = async (v: Volumes, box: string) => new Map((await v.describeBox(box)).map((x) => [x.id, x.active]));

export function volumePortContract(name: string, make: () => Promise<VolumeHarness>, opts: ContractOptions = {}): void {
  describe(`volumePort: ${name}`, { skip: opts.skip ?? false }, () => {
    test("describeBox lists only the box's volumes, with the active flag", async () => {
      const h = await make();
      const box = fresh("box");
      const a = await h.seedVolume(box, true);
      const b = await h.seedVolume(box, false);
      await h.seedVolume(fresh("other"), true);
      const vs = await h.volumes.describeBox(box);
      assert.deepEqual(
        vs.map((v) => `${v.id}=${v.active}`).toSorted(),
        [`${a}=true`, `${b}=false`].toSorted(),
      );
      for (const v of vs) {
        assert.equal(v.zone, h.zone);
        assert.ok(v.sizeGiB > 0);
        assert.ok(["creating", "available", "in-use"].includes(v.state), v.state);
      }
      assert.deepEqual(await h.volumes.describeBox(fresh("nobox")), []);
    });

    test("moveActive clears the old volume and tags the new one", gap(opts.gaps, "moveActive"), async () => {
      const h = await make();
      const box = fresh("box");
      const a = await h.seedVolume(box, true);
      const b = await h.seedVolume(box, false);
      await h.volumes.moveActive(box, a, b);
      const by = await activeOf(h.volumes, box);
      assert.deepEqual([by.get(a), by.get(b)], [false, true]);
    });

    test("moveActive with no previous holder only tags the new volume", async () => {
      const h = await make();
      const box = fresh("box");
      const b = await h.seedVolume(box, false);
      await h.volumes.moveActive(box, null, b);
      assert.equal((await activeOf(h.volumes, box)).get(b), true);
    });

    test("moveActive refuses a volume of another box", async () => {
      const h = await make();
      const other = await h.seedVolume(fresh("other"), false);
      await rejectsWith(h.volumes.moveActive(fresh("box"), null, other), "invalid_input", false);
    });

    test("createFromSnapshot makes an inactive volume of the box in the zone", async () => {
      const h = await make();
      const box = fresh("box");
      const snap = await h.seedSnapshot();
      const id = await h.volumes.createFromSnapshot({ boxId: box, snapshotId: snap, zone: h.zone, token: fresh("tok") });
      const v = (await h.volumes.describeBox(box)).find((x) => x.id === id);
      assert.ok(v);
      assert.deepEqual([v.active, v.zone], [false, h.zone]);
    });

    test("createFromSnapshot with the same token returns the same volume", gap(opts.gaps, "createToken"), async () => {
      const h = await make();
      const box = fresh("box");
      const snap = await h.seedSnapshot();
      const token = fresh("tok");
      const first = await h.volumes.createFromSnapshot({ boxId: box, snapshotId: snap, zone: h.zone, token });
      const again = await h.volumes.createFromSnapshot({ boxId: box, snapshotId: snap, zone: h.zone, token });
      assert.equal(again, first);
      assert.equal((await h.volumes.describeBox(box)).length, 1);
    });

    test("createFromSnapshot of a missing snapshot -> aws_not_found", gap(opts.gaps, "snapshots"), async () => {
      const h = await make();
      await rejectsWith(
        h.volumes.createFromSnapshot({ boxId: fresh("box"), snapshotId: "snap-0000000000000dead", zone: h.zone, token: fresh("t") }),
        "aws_not_found",
        false,
      );
    });

    test("describe throttled -> aws_throttled; create over the volume quota -> aws_limit", async () => {
      const h = await make();
      h.inject("describe", "RequestLimitExceeded", 503);
      await rejectsWith(h.volumes.describeBox(fresh("box")), "aws_throttled", true);
      h.inject("create", "VolumeLimitExceeded", 400);
      const snap = await h.seedSnapshot();
      await rejectsWith(
        h.volumes.createFromSnapshot({ boxId: fresh("box"), snapshotId: snap, zone: h.zone, token: fresh("t") }),
        "aws_limit",
        false,
      );
    });
  });
}

export function volumeAttachContract(name: string, make: () => Promise<AttachHarness>, opts: ContractOptions = {}): void {
  describe(`volumeAttach: ${name}`, { skip: opts.skip ?? false }, () => {
    test("findActive returns the box's active volume, or null; describe of a missing volume is null", async () => {
      const h = await make();
      const box = fresh("box");
      await h.seedVolume(box, false);
      assert.equal(await h.attach.findActive(box), null);
      const active = await h.seedVolume(box, true);
      const found = await h.attach.findActive(box);
      assert.deepEqual([found?.id, found?.active, found?.zone, found?.attachment], [active, true, h.zone, null]);
      assert.equal(await h.attach.describe("vol-0000000000000dead"), null);
    });

    test("attach the active volume -> attached to that machine; attaching again is not an error", async () => {
      const h = await make();
      const box = fresh("box");
      const vol = await h.seedVolume(box, true);
      const machine = await h.seedMachine();
      await h.attach.attach({ boxId: box, volumeId: vol, machineId: machine, device: "/dev/sdf" });
      await h.settleAttached(vol, machine);
      assert.deepEqual((await h.attach.describe(vol))?.attachment, { machineId: machine, state: "attached" });
      await h.attach.attach({ boxId: box, volumeId: vol, machineId: machine, device: "/dev/sdf" });
    });

    test("attach refuses an inactive volume and another box's volume (the tag fence)", async () => {
      const h = await make();
      const box = fresh("box");
      const inactive = await h.seedVolume(box, false);
      const foreign = await h.seedVolume(fresh("other"), true);
      const machine = await h.seedMachine();
      for (const volumeId of [inactive, foreign]) {
        await rejectsWith(h.attach.attach({ boxId: box, volumeId, machineId: machine, device: "/dev/sdf" }), "aws_denied", false);
        assert.equal((await h.attach.describe(volumeId))?.attachment, null);
      }
      await rejectsWith(
        h.attach.attach({ boxId: box, volumeId: "vol-0000000000000dead", machineId: machine, device: "/dev/sdf" }),
        "aws_not_found",
        false,
      );
    });

    test("attach failing with VolumeInUse -> aws_conflict; describe throttled -> aws_throttled", async () => {
      const h = await make();
      const box = fresh("box");
      const vol = await h.seedVolume(box, true);
      const machine = await h.seedMachine();
      h.inject("attach", "VolumeInUse", 400);
      await rejectsWith(h.attach.attach({ boxId: box, volumeId: vol, machineId: machine, device: "/dev/sdf" }), "aws_conflict", true);
      h.inject("describe", "RequestLimitExceeded", 503);
      await rejectsWith(h.attach.findActive(box), "aws_throttled", true);
    });
  });
}
