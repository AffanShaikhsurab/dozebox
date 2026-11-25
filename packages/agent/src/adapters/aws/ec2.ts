// AWS adapter for the box stopping itself: StopInstances on its own id (persistent mode), or its group's desired
// capacity to 0 (group mode). Neither call takes a client token (see the control adapter's ec2.ts); both are safe to
// repeat: StopInstances on a stopping or stopped instance succeeds, and desired 0 on a group at 0 changes nothing.
import {
  AutoScalingClient,
  SetDesiredCapacityCommand,
  type AutoScalingClientConfig,
} from "@aws-sdk/client-auto-scaling";
import { EC2Client, StopInstancesCommand, type EC2ClientConfig } from "@aws-sdk/client-ec2";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import type { SelfStop } from "../../ports/selfstop.ts";

/** The box's EC2 client, shared by self-stop and the volume attach adapter. */
export const ec2Client = (cfg: EC2ClientConfig): EC2Client => new EC2Client(cfg);
export const asgClient = (cfg: AutoScalingClientConfig): AutoScalingClient => new AutoScalingClient(cfg);

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
          new SetDesiredCapacityCommand({
            AutoScalingGroupName: target.groupName,
            DesiredCapacity: 0,
            HonorCooldown: false,
          }),
        );
      } catch (e) {
        const err = fromAws(e);
        if (target.mode === "group" && err.code === "invalid_input" && /not found/i.test(err.message)) {
          throw new RunnerError("aws_not_found", false, `Auto Scaling group '${target.groupName}' not found`, {
            cause: e,
          });
        }
        throw err;
      }
    },
  };
}
