// FakeAws EBS: tagged data volumes, snapshots, CreateVolume client tokens, and the attach tag fence.
import { RunnerError } from "@dozebox/core/errors";
import type { AttachedVolume, VolumeAttach } from "@dozebox/agent/ports/volumes";
import type { VolumeView, Volumes } from "@dozebox/control/ports/volumes";
import type { FakeEc2 } from "./ec2.ts";
import { awsError, type Faults, type Now, type Tags } from "./world.ts";

export type FakeEbsTiming = { readonly createMs: number; readonly attachMs: number };
export const DEFAULT_EBS_TIMING: FakeEbsTiming = { createMs: 5_000, attachMs: 2_000 };

type Volume = {
  readonly id: string;
  readonly zone: string;
  readonly sizeGiB: number;
  readonly createdAt: number;
  readonly tags: Map<string, string>;
  attachment: { readonly machineId: string; readonly at: number } | null;
};

export type FakeEbs = {
  readonly volumes: Volumes;
  readonly attach: VolumeAttach;
  readonly addVolume: (v: {
    readonly boxId: string;
    readonly active: boolean;
    readonly zone?: string;
    readonly sizeGiB?: number;
  }) => string;
  readonly addSnapshot: (sizeGiB?: number) => string;
  /** The volume's tags, for assertions. */
  readonly tagsOf: (id: string) => ReadonlyMap<string, string> | null;
};

export function makeFakeEbs(deps: {
  readonly clock: Now;
  readonly faults: Faults;
  readonly tags: Tags;
  readonly ec2: FakeEc2;
  readonly newId: (kind: "vol" | "snap") => string;
  readonly timing: FakeEbsTiming;
}): FakeEbs {
  const { clock, faults, tags, ec2, timing } = deps;
  const volumes = new Map<string, Volume>();
  const snapshots = new Map<string, number>();
  const byToken = new Map<string, { readonly id: string; readonly snapshotId: string; readonly zone: string }>();

  const get = (id: string): Volume => {
    const v = volumes.get(id);
    if (!v) throw awsError("InvalidVolume.NotFound", `The volume '${id}' does not exist.`);
    return v;
  };
  const isActive = (v: Volume): boolean => v.tags.get(tags.active) === "true";
  const attachmentState = (v: Volume): "attaching" | "attached" | null =>
    v.attachment === null ? null : clock.now() >= v.attachment.at + timing.attachMs ? "attached" : "attaching";
  const view = (v: Volume): VolumeView => {
    const a = attachmentState(v);
    return {
      id: v.id,
      zone: v.zone,
      sizeGiB: v.sizeGiB,
      active: isActive(v),
      state: clock.now() < v.createdAt + timing.createMs ? "creating" : a === null ? "available" : "in-use",
      attachments: v.attachment && a ? [{ machineId: v.attachment.machineId, state: a }] : [],
    };
  };
  const attachedView = (v: Volume): AttachedVolume => {
    const a = attachmentState(v);
    return {
      id: v.id,
      zone: v.zone,
      active: isActive(v),
      attachment: v.attachment && a ? { machineId: v.attachment.machineId, state: a } : null,
    };
  };
  const ofBox = (boxId: string): Volume[] =>
    [...volumes.values()].filter((v) => v.tags.get(tags.box) === boxId).toSorted((a, b) => a.createdAt - b.createdAt);
  const add = (boxId: string, active: boolean, zone: string, sizeGiB: number, createdAt: number): string => {
    const id = deps.newId("vol");
    volumes.set(id, {
      id,
      zone,
      sizeGiB,
      createdAt,
      tags: new Map([
        [tags.box, boxId],
        [tags.active, String(active)],
      ]),
      attachment: null,
    });
    return id;
  };
  const setTag = (v: Volume, boxId: string, value: boolean): void => {
    faults.check("ebs.tag");
    if (v.tags.get(tags.box) !== boxId) {
      throw awsError("InvalidParameterValue", `The volume '${v.id}' does not belong to box '${boxId}'.`);
    }
    v.tags.set(tags.active, String(value));
  };

  return {
    volumes: {
      describeBox: async (boxId) => {
        faults.check("ebs.describe");
        return ofBox(boxId).map(view);
      },
      moveActive: async (boxId, fromId, toId) => {
        const to = get(toId);
        if (fromId !== null) setTag(get(fromId), boxId, false);
        setTag(to, boxId, true);
      },
      createFromSnapshot: async ({ boxId, snapshotId, zone, token }) => {
        faults.check("ebs.create");
        const seen = byToken.get(token);
        if (seen) {
          if (seen.snapshotId !== snapshotId || seen.zone !== zone) {
            throw awsError("IdempotentParameterMismatch", "The client token was used with other parameters.");
          }
          return seen.id;
        }
        const size = snapshots.get(snapshotId);
        if (size === undefined)
          throw awsError("InvalidSnapshot.NotFound", `The snapshot '${snapshotId}' does not exist.`);
        const id = add(boxId, false, zone, size, clock.now());
        byToken.set(token, { id, snapshotId, zone });
        return id;
      },
    },
    attach: {
      findActive: async (boxId) => {
        faults.check("ebs.describe");
        const active = ofBox(boxId).filter(isActive);
        if (active.length > 1) {
          throw new RunnerError("internal", false, `box ${boxId} has ${active.length} volumes tagged active`);
        }
        return active[0] ? attachedView(active[0]) : null;
      },
      describe: async (volumeId) => {
        faults.check("ebs.describe");
        const v = volumes.get(volumeId);
        return v ? attachedView(v) : null;
      },
      attach: async ({ boxId, volumeId, machineId }) => {
        faults.check("ebs.attach");
        const v = get(volumeId);
        if (v.tags.get(tags.box) !== boxId || !isActive(v)) {
          throw awsError(
            "UnauthorizedOperation",
            `The volume '${volumeId}' is not the active volume of box '${boxId}'.`,
            403,
          );
        }
        const zone = ec2.zoneOf(machineId);
        if (zone === null)
          throw awsError("InvalidInstanceID.NotFound", `The instance ID '${machineId}' does not exist`);
        if (zone !== v.zone)
          throw awsError("InvalidVolume.ZoneMismatch", "The volume and instance are in different zones.");
        if (view(v).state === "creating")
          throw awsError("IncorrectState", `The volume '${volumeId}' is still creating.`);
        if (v.attachment) {
          if (v.attachment.machineId === machineId) return;
          throw awsError("VolumeInUse", `The volume '${volumeId}' is attached to another instance.`);
        }
        v.attachment = { machineId, at: clock.now() };
      },
    },
    addVolume: ({ boxId, active, zone = "us-east-1a", sizeGiB = 8 }) =>
      add(boxId, active, zone, sizeGiB, clock.now() - timing.createMs),
    addSnapshot: (sizeGiB = 8) => {
      const id = deps.newId("snap");
      snapshots.set(id, sizeGiB);
      return id;
    },
    tagsOf: (id) => volumes.get(id)?.tags ?? null,
  };
}
