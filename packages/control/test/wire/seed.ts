// Seeds for the wire tests: create what the Terraform module would have created, on the emulator, tagged the way
// the module tags it. Each harness builds new clients, so fault injectors never leak between cases.
import { AutoScalingClient, CreateAutoScalingGroupCommand } from "@aws-sdk/client-auto-scaling";
import {
  AttachVolumeCommand,
  CreateLaunchTemplateCommand,
  CreateSnapshotCommand,
  CreateVolumeCommand,
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import { fresh } from "@dozebox/testkit/contracts";
import { eventually, type WireConfig } from "@dozebox/testkit/wire";

export const ZONE = "us-east-1a";
/** Any image id the emulator accepts. `DOZEBOX_WIRE_AMI` overrides it. */
const AMI = process.env["DOZEBOX_WIRE_AMI"] ?? "ami-0123456789abcdef0";
const tags = (pairs: Record<string, string>) => Object.entries(pairs).map(([Key, Value]) => ({ Key, Value }));

export const clients = (config: WireConfig) => ({ ec2: new EC2Client(config), asg: new AutoScalingClient(config) });

async function stateOf(ec2: EC2Client, id: string): Promise<string | undefined> {
  const out = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "instance-id", Values: [id] }] }));
  return out.Reservations?.[0]?.Instances?.[0]?.State?.Name;
}

/** One instance in ZONE with `tagPairs`, running, or stopped once it ran. */
export async function runInstance(
  ec2: EC2Client,
  tagPairs: Record<string, string>,
  state: "running" | "stopped" = "running",
): Promise<string> {
  const out = await ec2.send(
    new RunInstancesCommand({
      ImageId: AMI,
      InstanceType: "t4g.small",
      MinCount: 1,
      MaxCount: 1,
      ClientToken: fresh("run"),
      Placement: { AvailabilityZone: ZONE },
      TagSpecifications: [{ ResourceType: "instance", Tags: tags(tagPairs) }],
    }),
  );
  const id = out.Instances?.[0]?.InstanceId;
  if (!id) throw new Error("RunInstances returned no instance id");
  await eventually(async () => (await stateOf(ec2, id)) === "running", `${id} running`);
  if (state === "stopped") {
    await ec2.send(new StopInstancesCommand({ InstanceIds: [id] }));
    await eventually(async () => (await stateOf(ec2, id)) === "stopped", `${id} stopped`);
  }
  return id;
}

/** A min 0 / max 1 group at desired 0, from a new launch template. */
export async function createGroup(ec2: EC2Client, asg: AutoScalingClient, name: string, boxId: string): Promise<void> {
  const template = fresh("dz-lt");
  await ec2.send(
    new CreateLaunchTemplateCommand({
      LaunchTemplateName: template,
      LaunchTemplateData: { ImageId: AMI, InstanceType: "t4g.small" },
    }),
  );
  await asg.send(
    new CreateAutoScalingGroupCommand({
      AutoScalingGroupName: name,
      MinSize: 0,
      MaxSize: 1,
      DesiredCapacity: 0,
      LaunchTemplate: { LaunchTemplateName: template, Version: "$Latest" },
      AvailabilityZones: [ZONE],
      Tags: [{ Key: "dozebox:box", Value: boxId, PropagateAtLaunch: true }],
    }),
  );
}

/** A 1 GiB volume of `boxId` in ZONE. */
export async function createVolume(ec2: EC2Client, boxId: string, active: boolean, zone = ZONE): Promise<string> {
  const out = await ec2.send(
    new CreateVolumeCommand({
      AvailabilityZone: zone,
      Size: 1,
      VolumeType: "gp3",
      TagSpecifications: [
        { ResourceType: "volume", Tags: tags({ "dozebox:box": boxId, "dozebox:active": String(active) }) },
      ],
    }),
  );
  if (!out.VolumeId) throw new Error("CreateVolume returned no volume id");
  return out.VolumeId;
}

/** A snapshot of a new volume, tagged to `boxId` when given; where the emulator has no snapshots, an id it accepts. */
export async function createSnapshot(ec2: EC2Client, boxId?: string): Promise<string> {
  const vol = await createVolume(ec2, fresh("snapsrc"), false);
  try {
    const out = await ec2.send(
      new CreateSnapshotCommand({
        VolumeId: vol,
        ...(boxId === undefined
          ? {}
          : { TagSpecifications: [{ ResourceType: "snapshot", Tags: tags({ "dozebox:box": boxId }) }] }),
      }),
    );
    if (out.SnapshotId) return out.SnapshotId;
  } catch {
    // No snapshots on this target: the snapshot cases are gaps there, covered by FakeAws.
  }
  return "snap-0123456789abcdef0";
}

/** A volume of `boxId` attached to a new running instance. */
export async function attachedVolume(
  ec2: EC2Client,
  boxId: string,
  active: boolean,
): Promise<{ readonly volumeId: string; readonly machineId: string }> {
  const machineId = await runInstance(ec2, { "dozebox:box": fresh("m"), "dozebox:role": "persistent" });
  // The emulator ignores Placement, so the volume goes where the instance landed.
  const placed = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [machineId] }));
  const volumeId = await createVolume(ec2, boxId, active, placed.Reservations?.[0]?.Instances?.[0]?.Placement?.AvailabilityZone);
  await ec2.send(new AttachVolumeCommand({ VolumeId: volumeId, InstanceId: machineId, Device: "/dev/sdf" }));
  return { volumeId, machineId };
}
