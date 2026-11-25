// AWS adapter for the On-Demand fallback group (Auto Scaling, min 0 / max 1). SetDesiredCapacity takes no client
// token (see ec2.ts); setting the same desired capacity twice is harmless, so the port's token is not sent.
import {
  DescribeAutoScalingGroupsCommand,
  SetDesiredCapacityCommand,
  type AutoScalingClient,
} from "@aws-sdk/client-auto-scaling";
import { DescribeInstancesCommand, type EC2Client } from "@aws-sdk/client-ec2";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import type { Compute, MachineView } from "../../ports/compute.ts";
import { toMachineView } from "./ec2.ts";

export type AwsGroupDeps = { readonly asg: AutoScalingClient; readonly ec2: EC2Client };

const notFound = (name: string) => new RunnerError("aws_not_found", false, `Auto Scaling group '${name}' not found`);

export function makeAwsGroup(deps: AwsGroupDeps): Pick<Compute, "describeGroup" | "setGroupDesired"> {
  const { asg, ec2 } = deps;
  return {
    describeGroup: async (name) => {
      try {
        const out = await asg.send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [name] }));
        const g = out.AutoScalingGroups?.[0];
        if (!g) throw notFound(name);
        const ids = (g.Instances ?? []).map((i) => i.InstanceId).filter((id): id is string => Boolean(id));
        let machines: MachineView[] = [];
        if (ids.length > 0) {
          const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: ids }));
          machines = (desc.Reservations ?? [])
            .flatMap((r) => r.Instances ?? [])
            .map((i) => toMachineView(i, null))
            .filter((m) => m.state !== "terminated");
        }
        // The group is min 0 / max 1 (Terraform checks it); anything else is reported as raised.
        return { desired: (g.DesiredCapacity ?? 0) > 0 ? 1 : 0, machines };
      } catch (e) {
        throw fromAws(e);
      }
    },
    setGroupDesired: async (name, desired, _token) => {
      try {
        await asg.send(
          new SetDesiredCapacityCommand({ AutoScalingGroupName: name, DesiredCapacity: desired, HonorCooldown: false }),
        );
      } catch (e) {
        const err = fromAws(e);
        // Auto Scaling answers an unknown group with ValidationError "Auto Scaling group '<name>' not found."
        if (err.code === "invalid_input" && /not found/i.test(err.message)) throw notFound(name);
        throw err;
      }
    },
  };
}
