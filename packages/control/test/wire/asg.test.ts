// Wire: the Auto Scaling adapter against the emulator, through the same groupPort contract FakeAws passes.
import { groupPortContract, type GroupOp } from "@dozebox/testkit/contracts";
import { faultInjector, resolveWire } from "@dozebox/testkit/wire";
import { makeAwsGroup } from "../../src/adapters/aws/asg.ts";
import { clients, createGroup } from "./seed.ts";

const target = await resolveWire();
const COMMAND: Record<GroupOp, string> = {
  describe: "DescribeAutoScalingGroupsCommand",
  set: "SetDesiredCapacityCommand",
};

groupPortContract(
  "aws adapter on the emulator",
  async () => {
    const { ec2, asg } = clients(target.config);
    const seed = clients(target.config);
    const inject = faultInjector(asg);
    return {
      compute: makeAwsGroup({ asg, ec2 }),
      seedGroup: (name, boxId) => createGroup(seed.ec2, seed.asg, name, boxId),
      inject: (op, name, status) => inject(COMMAND[op], name, status),
    };
  },
  { skip: target.skip },
);
