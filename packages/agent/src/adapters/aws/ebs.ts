// AWS adapter for attaching the box's data volume at boot. The tag fence (`<prefix>:box` and `<prefix>:active=true`)
// is enforced by IAM on AWS and checked here on a fresh read too, because emulators do not evaluate IAM conditions.
// Never force-detaches.
import { AttachVolumeCommand, DescribeVolumesCommand, type EC2Client, type Volume } from "@aws-sdk/client-ec2";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import type { AttachedVolume, VolumeAttach } from "../../ports/volumes.ts";

type AttachState = NonNullable<AttachedVolume["attachment"]>["state"];
const LIVE_ATTACHMENT: ReadonlySet<string> = new Set(["attaching", "attached", "detaching", "busy"]);

export type AwsVolumeAttachDeps = { readonly ec2: EC2Client; readonly prefix?: string };

export function makeAwsVolumeAttach(deps: AwsVolumeAttachDeps): VolumeAttach {
  const { ec2 } = deps;
  const prefix = deps.prefix ?? "dozebox";
  const tag = (v: Volume, key: string) => v.Tags?.find((t) => t.Key === `${prefix}:${key}`)?.Value;
  const view = (v: Volume): AttachedVolume => {
    const a = (v.Attachments ?? []).find((x) => x.InstanceId && LIVE_ATTACHMENT.has(x.State ?? ""));
    return {
      id: v.VolumeId ?? "",
      zone: v.AvailabilityZone ?? "",
      active: tag(v, "active") === "true",
      attachment: a ? { machineId: a.InstanceId ?? "", state: a.State as AttachState } : null,
    };
  };
  const read = async (volumeId: string): Promise<Volume | null> => {
    try {
      const out = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
      return out.Volumes?.[0] ?? null;
    } catch (e) {
      const err = fromAws(e);
      if (err.code === "aws_not_found") return null;
      throw err;
    }
  };

  return {
    findActive: async (boxId) => {
      try {
        const out = await ec2.send(
          new DescribeVolumesCommand({
            Filters: [
              { Name: `tag:${prefix}:box`, Values: [boxId] },
              { Name: `tag:${prefix}:active`, Values: ["true"] },
            ],
          }),
        );
        const vs = out.Volumes ?? [];
        if (vs.length > 1) throw new RunnerError("internal", false, `box ${boxId} has ${vs.length} volumes tagged active`);
        return vs[0] ? view(vs[0]) : null;
      } catch (e) {
        throw fromAws(e);
      }
    },
    describe: async (volumeId) => {
      const v = await read(volumeId);
      return v ? view(v) : null;
    },
    attach: async ({ boxId, volumeId, machineId, device }) => {
      const v = await read(volumeId);
      if (!v) throw new RunnerError("aws_not_found", false, `volume ${volumeId} does not exist`);
      if (tag(v, "box") !== boxId || tag(v, "active") !== "true") {
        throw new RunnerError("aws_denied", false, `volume ${volumeId} is not the active volume of box ${boxId}`);
      }
      if (view(v).attachment?.machineId === machineId) return;
      try {
        await ec2.send(new AttachVolumeCommand({ VolumeId: volumeId, InstanceId: machineId, Device: device }));
      } catch (e) {
        throw fromAws(e);
      }
    },
  };
}
