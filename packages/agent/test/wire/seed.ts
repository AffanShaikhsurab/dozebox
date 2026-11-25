// Seeds for the agent's wire tests, on the emulator, tagged the way the Terraform module tags things.
import {
  AutoScalingClient,
  CreateAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
} from "@aws-sdk/client-auto-scaling";
import {
  CreateLaunchTemplateCommand,
  CreateVolumeCommand,
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
} from "@aws-sdk/client-ec2";
import { fresh } from "@dozebox/testkit/contracts";
import { eventually, type WireConfig } from "@dozebox/testkit/wire";

export const ZONE = "us-east-1a";
/** Any image id the emulator accepts. `DOZEBOX_WIRE_AMI` overrides it. */
const AMI = process.env["DOZEBOX_WIRE_AMI"] ?? "ami-0123456789abcdef0";

export const clients = (config: WireConfig) => ({ ec2: new EC2Client(config), asg: new AutoScalingClient(config) });

export async function instanceState(ec2: EC2Client, id: string): Promise<string | undefined> {
  const out = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "instance-id", Values: [id] }] }));
  return out.Reservations?.[0]?.Instances?.[0]?.State?.Name;
}

export async function groupDesired(asg: AutoScalingClient, name: string): Promise<number | undefined> {
  const out = await asg.send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [name] }));
  return out.AutoScalingGroups?.[0]?.DesiredCapacity;
}

/** A running instance in ZONE. */
export async function runInstance(ec2: EC2Client): Promise<string> {
  const out = await ec2.send(
    new RunInstancesCommand({
      ImageId: AMI,
      InstanceType: "t4g.small",
      MinCount: 1,
      MaxCount: 1,
      ClientToken: fresh("run"),
      Placement: { AvailabilityZone: ZONE },
      TagSpecifications: [{ ResourceType: "instance", Tags: [{ Key: "dozebox:box", Value: fresh("m") }] }],
    }),
  );
  const id = out.Instances?.[0]?.InstanceId;
  if (!id) throw new Error("RunInstances returned no instance id");
  await eventually(async () => (await instanceState(ec2, id)) === "running", `${id} running`);
  return id;
}

/** A min 0 / max 1 group at `desired`, from a new launch template. */
export async function createGroup(ec2: EC2Client, asg: AutoScalingClient, name: string, desired: 0 | 1): Promise<void> {
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
      DesiredCapacity: desired,
      LaunchTemplate: { LaunchTemplateName: template, Version: "$Latest" },
      AvailabilityZones: [ZONE],
    }),
  );
}

/** A 1 GiB volume of `boxId` in ZONE. */
export async function createVolume(ec2: EC2Client, boxId: string, active: boolean): Promise<string> {
  const out = await ec2.send(
    new CreateVolumeCommand({
      AvailabilityZone: ZONE,
      Size: 1,
      VolumeType: "gp3",
      TagSpecifications: [
        {
          ResourceType: "volume",
          Tags: [
            { Key: "dozebox:box", Value: boxId },
            { Key: "dozebox:active", Value: String(active) },
          ],
        },
      ],
    }),
  );
  if (!out.VolumeId) throw new Error("CreateVolume returned no volume id");
  return out.VolumeId;
}
