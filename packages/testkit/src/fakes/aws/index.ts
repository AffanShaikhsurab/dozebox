// FakeAws: one in-memory account that implements every cloud port, with the AWS behaviour the reconciler depends on
// (stale describes, Spot request states, client tokens, conditional writes) and one-shot faults.
import type { SelfStop } from "@dozebox/agent/ports/selfstop";
import type { Compute } from "@dozebox/control/ports/compute";
import { makeFakeClock, type FakeClock } from "../clock.ts";
import { makeFakeAsg, type FakeAsg } from "./asg.ts";
import { DEFAULT_EBS_TIMING, makeFakeEbs, type FakeEbs, type FakeEbsTiming } from "./ebs.ts";
import { DEFAULT_EC2_TIMING, makeFakeEc2, type FakeEc2, type FakeEc2Timing } from "./ec2.ts";
import {
  makeFakeBudgets,
  makeFakeDynamoDb,
  makeFakeLogs,
  makeFakeSns,
  makeFakeSsm,
  type FakeBudgets,
  type FakeDynamoDb,
  type FakeLogs,
  type FakeSns,
  type FakeSsm,
} from "./services.ts";
import { makeFaults, makeIds, tagNames, type Faults } from "./world.ts";

export type FakeAwsOptions = {
  readonly clock?: FakeClock;
  /** Tag and parameter prefix. Default `dozebox`. */
  readonly prefix?: string;
  readonly ec2Timing?: Partial<FakeEc2Timing>;
  readonly ebsTiming?: Partial<FakeEbsTiming>;
};

export type FakeAws = {
  readonly clock: FakeClock;
  readonly faults: Faults;
  readonly prefix: string;
  readonly ec2: FakeEc2;
  readonly asg: FakeAsg;
  readonly ebs: FakeEbs;
  readonly ssm: FakeSsm;
  readonly dynamodb: FakeDynamoDb;
  readonly budgets: FakeBudgets;
  readonly sns: FakeSns;
  readonly logs: FakeLogs;
  /** The control function's ports. */
  readonly compute: Compute;
  /** The agent's self-stop: StopInstances on itself, or its group to 0. */
  readonly selfStop: SelfStop;
};

export function makeFakeAws(opts: FakeAwsOptions = {}): FakeAws {
  const clock = opts.clock ?? makeFakeClock();
  const prefix = opts.prefix ?? "dozebox";
  const faults = makeFaults();
  const tags = tagNames(prefix);
  const id = makeIds();
  const ec2 = makeFakeEc2({
    clock,
    faults,
    tags,
    newId: () => id("i"),
    timing: { ...DEFAULT_EC2_TIMING, ...opts.ec2Timing },
  });
  const asg = makeFakeAsg({ faults, ec2 });
  const ebs = makeFakeEbs({
    clock,
    faults,
    tags,
    ec2,
    newId: id,
    timing: { ...DEFAULT_EBS_TIMING, ...opts.ebsTiming },
  });
  return {
    clock,
    faults,
    prefix,
    ec2,
    asg,
    ebs,
    ssm: makeFakeSsm({ clock, faults }),
    dynamodb: makeFakeDynamoDb({ clock, faults }),
    budgets: makeFakeBudgets({ faults }),
    sns: makeFakeSns({ faults, newId: () => id("msg") }),
    logs: makeFakeLogs({ faults }),
    compute: { ...ec2.compute, ...asg.compute },
    selfStop: {
      stopSelf: async (target) => {
        if (target.mode === "group")
          return asg.compute.setGroupDesired(target.groupName, 0, `self-${target.instanceId}`);
        const state = ec2.machine(target.instanceId)?.state;
        if (state === "stopping" || state === "stopped") return;
        return ec2.compute.stopPersistent(target.instanceId, `self-${target.instanceId}`);
      },
    },
  };
}

export type { FakeAsg, FakeBudgets, FakeDynamoDb, FakeEbs, FakeEc2, FakeLogs, FakeSns, FakeSsm, Faults };
export type { FakeEc2Timing } from "./ec2.ts";
export type { FakeEbsTiming } from "./ebs.ts";
export type { FaultOp } from "./world.ts";
