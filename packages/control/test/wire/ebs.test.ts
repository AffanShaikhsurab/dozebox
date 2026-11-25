// Wire: the EBS adapter against the emulator, through the same volumePort contract FakeAws passes.
import { volumePortContract } from "@dozebox/testkit/contracts";
import { faultInjector, resolveWire } from "@dozebox/testkit/wire";
import { makeAwsVolumes } from "../../src/adapters/aws/ebs.ts";
import { clients, createSnapshot, createVolume, ZONE } from "./seed.ts";

const target = await resolveWire();
const COMMAND = { describe: "DescribeVolumesCommand", create: "CreateVolumeCommand" } as const;

volumePortContract(
  "aws adapter on the emulator",
  async () => {
    const { ec2 } = clients(target.config);
    const seed = clients(target.config).ec2;
    const inject = faultInjector(ec2);
    return {
      volumes: makeAwsVolumes({ ec2 }),
      zone: ZONE,
      seedVolume: (boxId, active) => createVolume(seed, boxId, active),
      seedSnapshot: () => createSnapshot(seed),
      inject: (op, name, status) => inject(COMMAND[op], name, status),
    };
  },
  {
    skip: target.skip,
    // What Floci 2.3.0 does not model (test/emulator/README.md); FakeAws and the unit tests cover these.
    gaps: {
      createToken: "Floci ignores the CreateVolume ClientToken (two calls, two volumes)",
      snapshots: "Floci does not model snapshots, so a missing snapshot is not refused",
      moveActive: "Floci does not overwrite an existing tag value on CreateTags",
    },
  },
);
