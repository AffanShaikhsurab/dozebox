// Every cloud port contract suite, run against FakeAws. The same suites run against the emulator in the wire tests.
import type { MachineState } from "@dozebox/control/ports/compute";
import {
  ec2PortContract,
  groupPortContract,
  recordStoreContract,
  spendPortContract,
  stateTableContract,
  volumePortContract,
} from "../src/contracts/index.ts";
import { fresh } from "../src/contracts/support.ts";
import { makeFakeAws, type FakeAws, type FaultOp } from "../src/fakes/index.ts";

/** Advance fake time in 5 s steps until `done` holds (at most 10 minutes of fake time). */
async function until(aws: FakeAws, done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await done()) return;
    aws.clock.advance(5_000);
  }
  throw new Error("FakeAws did not settle within 10 minutes of fake time");
}

ec2PortContract("FakeAws", async () => {
  const aws = makeFakeAws();
  const ops: Record<"describe" | "start" | "stop", FaultOp> = {
    describe: "ec2.describe",
    start: "ec2.start",
    stop: "ec2.stop",
  };
  return {
    compute: aws.compute,
    seedPersistent: async (boxId, state) => aws.ec2.addMachine({ boxId, role: "persistent", state, lifecycle: "spot" }),
    settle: (boxId: string, want: MachineState) =>
      until(aws, async () => (await aws.compute.describePersistent(boxId))?.state === want),
    inject: (op, name, status) => aws.faults.failNext(ops[op], name, status),
  };
});

groupPortContract("FakeAws", async () => {
  const aws = makeFakeAws();
  return {
    compute: aws.compute,
    seedGroup: async (name, boxId) => aws.asg.addGroup(name, { boxId }),
    inject: (op, name, status) => aws.faults.failNext(op === "set" ? "asg.setDesired" : "asg.describe", name, status),
  };
});

volumePortContract("FakeAws", async () => {
  const aws = makeFakeAws();
  const zone = "us-east-1a";
  return {
    volumes: aws.ebs.volumes,
    attach: aws.ebs.attach,
    zone,
    seedVolume: async (boxId, active) => aws.ebs.addVolume({ boxId, active, zone }),
    seedSnapshot: async () => aws.ebs.addSnapshot(),
    seedMachine: async () =>
      aws.ec2.addMachine({ boxId: fresh("m"), role: "persistent", state: "running", lifecycle: "spot", zone }),
    settleAttached: (volumeId) =>
      until(aws, async () => (await aws.ebs.attach.describe(volumeId))?.attachment?.state === "attached"),
    inject: (op, name, status) => aws.faults.failNext(op === "attach" ? "ebs.attach" : "ebs.describe", name, status),
  };
});

recordStoreContract("FakeAws", async () => {
  const aws = makeFakeAws();
  const store = aws.ssm.store(`/dozebox/${fresh("box")}/`);
  let calls = 0;
  const counted =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      const r = await f(...a);
      calls++;
      return r;
    };
  return {
    writer: { put: counted(store.put), delete: counted(store.delete) },
    reader: store,
    calls: () => calls,
    inject: (op, name, status) => aws.faults.failNext(op === "put" ? "ssm.put" : "ssm.get", name, status),
  };
});

stateTableContract("FakeAws", async () => {
  const aws = makeFakeAws();
  return {
    table: aws.dynamodb.table,
    pass: async (ms) => aws.clock.advance(ms),
    now: () => aws.clock.now(),
    inject: (op, name, status) => aws.faults.failNext(op === "write" ? "dynamodb.write" : "dynamodb.get", name, status),
  };
});

spendPortContract("FakeAws", async () => {
  const aws = makeFakeAws();
  return {
    spendWith: async (usd) => {
      aws.budgets.setMonthToDate(usd === null ? null : { usd, asOf: aws.clock.now() });
      return aws.budgets.spend;
    },
    inject: (_spend, name, status) => aws.faults.failNext("budgets.describe", name, status),
  };
});
