// AWS adapter for the box stopping itself: StopInstances on its own id (persistent mode), or its group's desired
// capacity to 0 (group mode). Neither call takes a client token; both are safe to repeat.
import { SetDesiredCapacityCommand, type AutoScalingClient } from "@aws-sdk/client-auto-scaling";
import { StopInstancesCommand, type EC2Client } from "@aws-sdk/client-ec2";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import type { SelfStop } from "../../ports/selfstop.ts";

export type AwsSelfStopDeps = { readonly ec2: EC2Client; readonly asg: AutoScalingClient };

export function makeAwsSelfStop(deps: AwsSelfStopDeps): SelfStop {
  return {
    stopSelf: async (target) => {
      try {
        if (target.mode === "persistent") {
          await deps.ec2.send(new StopInstancesCommand({ InstanceIds: [target.instanceId] }));
          return;
        }
        await deps.asg.send(
          new SetDesiredCapacityCommand({ AutoScalingGroupName: target.groupName, DesiredCapacity: 0, HonorCooldown: false }),
        );
      } catch (e) {
        const err = fromAws(e);
        if (target.mode === "group" && err.code === "invalid_input" && /not found/i.test(err.message)) {
          throw new RunnerError("aws_not_found", false, `Auto Scaling group '${target.groupName}' not found`, { cause: e });
        }
        throw err;
      }
    },
  };
}
