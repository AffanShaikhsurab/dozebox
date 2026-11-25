// Wire: the EC2 adapter against the emulator, through the same ec2Port contract FakeAws passes.
// Skips cleanly when no emulator answers (see @dozebox/testkit/wire).
import { ec2PortContract, type Ec2Op } from "@dozebox/testkit/contracts";
import { eventually, faultInjector, resolveWire } from "@dozebox/testkit/wire";
import { makeAwsMachines } from "../../src/adapters/aws/ec2.ts";
import { clients, runInstance } from "./seed.ts";

const target = await resolveWire();
const COMMAND: Record<Ec2Op, string> = {
  describe: "DescribeInstancesCommand",
  start: "StartInstancesCommand",
  stop: "StopInstancesCommand",
};

ec2PortContract(
  "aws adapter on the emulator",
  async () => {
    const { ec2 } = clients(target.config);
    const seedClient = clients(target.config).ec2;
    const inject = faultInjector(ec2);
    const compute = makeAwsMachines({ ec2 });
    return {
      compute,
      seedPersistent: (boxId, state) =>
        runInstance(seedClient, { "dozebox:box": boxId, "dozebox:role": "persistent" }, state),
      settle: (boxId, want) =>
        eventually(async () => (await compute.describePersistent(boxId))?.state === want, `${boxId} ${want}`),
      inject: (op, name, status) => inject(COMMAND[op], name, status),
    };
  },
  { skip: target.skip },
);
