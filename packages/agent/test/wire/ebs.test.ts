// Wire: the agent's volume attach adapter against the emulator, through the volumeAttach contract FakeAws passes.
import { volumeAttachContract } from "@dozebox/testkit/contracts";
import { eventually, faultInjector, resolveWire } from "@dozebox/testkit/wire";
import { makeAwsVolumeAttach } from "../../src/adapters/aws/ebs.ts";
import { clients, createVolume, runInstance, ZONE } from "./seed.ts";

const target = await resolveWire();
const COMMAND = { describe: "DescribeVolumesCommand", attach: "AttachVolumeCommand" } as const;

volumeAttachContract(
  "aws adapter on the emulator",
  async () => {
    const { ec2 } = clients(target.config);
    const seed = clients(target.config).ec2;
    const inject = faultInjector(ec2);
    const attach = makeAwsVolumeAttach({ ec2 });
    return {
      attach,
      zone: ZONE,
      seedVolume: (boxId, active) => createVolume(seed, boxId, active),
      seedMachine: () => runInstance(seed),
      settleAttached: (volumeId, machineId) =>
        eventually(async () => {
          const a = (await attach.describe(volumeId))?.attachment;
          return a?.machineId === machineId && a.state === "attached";
        }, `${volumeId} attached to ${machineId}`),
      inject: (op, name, status) => inject(COMMAND[op], name, status),
    };
  },
  { skip: target.skip },
);
