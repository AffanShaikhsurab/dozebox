// AWS adapter for the box's data volumes (EBS through the EC2 API): describe by tag, move the `active` tag, and
// create from a snapshot with CreateVolume's ClientToken. Never detaches or deletes anything.
import {
  CreateTagsCommand,
  CreateVolumeCommand,
  DescribeVolumesCommand,
  type EC2Client,
  type Volume,
} from "@aws-sdk/client-ec2";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import type { AttachmentState, VolumeState, VolumeView, Volumes } from "../../ports/volumes.ts";

const VOLUME_STATES: ReadonlySet<string> = new Set(["creating", "available", "in-use", "deleting", "deleted", "error"]);
const ATTACHMENT_STATES: ReadonlySet<string> = new Set(["attaching", "attached", "detaching", "detached", "busy"]);

const tag = (v: Volume, key: string): string | undefined => v.Tags?.find((t) => t.Key === key)?.Value;

export function toVolumeView(v: Volume, prefix: string): VolumeView {
  const state = v.State ?? "";
  if (!v.VolumeId || !VOLUME_STATES.has(state)) {
    throw new RunnerError("internal", false, "DescribeVolumes returned a volume without an id or a known state");
  }
  return {
    id: v.VolumeId,
    state: state as VolumeState,
    zone: v.AvailabilityZone ?? "",
    sizeGiB: v.Size ?? 0,
    active: tag(v, `${prefix}:active`) === "true",
    attachments: (v.Attachments ?? [])
      .filter((a) => a.InstanceId && ATTACHMENT_STATES.has(a.State ?? ""))
      .map((a) => ({ machineId: a.InstanceId ?? "", state: a.State as AttachmentState })),
  };
}

/** Every volume matching `filters`, across pages. */
export async function describeVolumes(
  ec2: EC2Client,
  input: { readonly Filters?: Array<{ Name: string; Values: string[] }>; readonly VolumeIds?: string[] },
): Promise<Volume[]> {
  const found: Volume[] = [];
  let next: string | undefined;
  do {
    const out = await ec2.send(new DescribeVolumesCommand({ ...input, NextToken: next }));
    found.push(...(out.Volumes ?? []));
    next = out.NextToken;
  } while (next);
  return found;
}

export type AwsVolumesDeps = { readonly ec2: EC2Client; readonly prefix?: string };

export function makeAwsVolumes(deps: AwsVolumesDeps): Volumes {
  const { ec2 } = deps;
  const prefix = deps.prefix ?? "dozebox";
  const boxTag = `${prefix}:box`;
  const activeTag = `${prefix}:active`;

  const setActive = async (id: string, value: boolean) =>
    ec2.send(new CreateTagsCommand({ Resources: [id], Tags: [{ Key: activeTag, Value: String(value) }] }));

  return {
    describeBox: async (boxId) => {
      try {
        const vs = await describeVolumes(ec2, { Filters: [{ Name: `tag:${boxTag}`, Values: [boxId] }] });
        return vs
          .toSorted((a, b) => (a.CreateTime?.getTime() ?? 0) - (b.CreateTime?.getTime() ?? 0))
          .map((v) => toVolumeView(v, prefix));
      } catch (e) {
        throw fromAws(e);
      }
    },
    moveActive: async (boxId, fromId, toId) => {
      try {
        const ids = fromId === null ? [toId] : [fromId, toId];
        const vs = await describeVolumes(ec2, { VolumeIds: ids });
        for (const id of ids) {
          if (tag(vs.find((v) => v.VolumeId === id) ?? {}, boxTag) !== boxId) {
            throw new RunnerError("invalid_input", false, `volume ${id} is not tagged ${boxTag}=${boxId}`);
          }
        }
        // Clear first: a crash between the two calls leaves no active volume, never two.
        if (fromId !== null) await setActive(fromId, false);
        await setActive(toId, true);
      } catch (e) {
        throw fromAws(e);
      }
    },
    createFromSnapshot: async ({ boxId, snapshotId, zone, token }) => {
      try {
        const out = await ec2.send(
          new CreateVolumeCommand({
            SnapshotId: snapshotId,
            AvailabilityZone: zone,
            VolumeType: "gp3",
            Encrypted: true,
            ClientToken: token,
            TagSpecifications: [
              {
                ResourceType: "volume",
                Tags: [
                  { Key: boxTag, Value: boxId },
                  { Key: activeTag, Value: "false" },
                ],
              },
            ],
          }),
        );
        if (!out.VolumeId) throw new RunnerError("internal", false, "CreateVolume returned no volume id");
        return out.VolumeId;
      } catch (e) {
        throw fromAws(e);
      }
    },
  };
}
