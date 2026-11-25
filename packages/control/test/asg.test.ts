// The Auto Scaling adapter offline: desired capacity and machines from recorded reads, instances not visible yet,
// a missing group as aws_not_found, and SetDesiredCapacity without a token or cooldown.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { awsFault, awsFixture, OFFLINE_CONFIG, stubSdk, type StubReply } from "@dozebox/testkit/wire";
import { asgClient, makeAwsGroup } from "../src/adapters/aws/asg.ts";
import { ec2Client, makeAwsCompute, makeAwsMachines } from "../src/adapters/aws/ec2.ts";

const group = (asgReply: StubReply, ec2Reply: StubReply = () => undefined) => {
  const asg = asgClient(OFFLINE_CONFIG);
  const ec2 = ec2Client(OFFLINE_CONFIG);
  const asgStub = stubSdk(asg, asgReply);
  const ec2Stub = stubSdk(ec2, ec2Reply);
  return { g: makeAwsGroup({ asg, ec2 }), asgStub, ec2Stub };
};

const rejectsCode = async (p: Promise<unknown>, code: string, retryable: boolean) =>
  assert.rejects(p, (e: unknown) => e instanceof RunnerError && e.code === code && e.retryable === retryable);

describe("describeGroup", () => {
  test("recorded raised group -> desired 1 and its On-Demand machine, read by instance-id filter", async () => {
    const { g, asgStub, ec2Stub } = group(
      () => awsFixture("describe-auto-scaling-groups.raised"),
      () => awsFixture("describe-instances.on-demand-running"),
    );
    const view = await g.describeGroup("dozebox-main-fallback");
    assert.equal(view.desired, 1);
    assert.deepEqual(
      view.machines.map((m) => [m.id, m.state, m.lifecycle]),
      [["i-0a1b2c3d4e5f60003", "running", "on-demand"]],
    );
    assert.deepEqual(asgStub.sent("DescribeAutoScalingGroupsCommand"), [
      { AutoScalingGroupNames: ["dozebox-main-fallback"] },
    ]);
    assert.deepEqual(ec2Stub.sent("DescribeInstancesCommand"), [
      { Filters: [{ Name: "instance-id", Values: ["i-0a1b2c3d4e5f60003"] }] },
    ]);
  });

  test("an instance the group launched but EC2 does not show yet is left out; desired still reads 1", async () => {
    const { g } = group(
      () => awsFixture("describe-auto-scaling-groups.raised"),
      () => ({ Reservations: [] }),
    );
    assert.deepEqual(await g.describeGroup("dozebox-main-fallback"), { desired: 1, machines: [] });
  });

  test("terminated instances still listed by the group are dropped", async () => {
    const { g } = group(
      () => awsFixture("describe-auto-scaling-groups.raised"),
      () => ({ Reservations: [{ Instances: [{ InstanceId: "i-0a1b2c3d4e5f60003", State: { Name: "terminated" } }] }] }),
    );
    assert.deepEqual((await g.describeGroup("dozebox-main-fallback")).machines, []);
  });

  test("a group at 0 with no instances does not call EC2", async () => {
    const { g, ec2Stub } = group(() => ({
      AutoScalingGroups: [{ AutoScalingGroupName: "g", MinSize: 0, MaxSize: 1, DesiredCapacity: 0, Instances: [] }],
    }));
    assert.deepEqual(await g.describeGroup("g"), { desired: 0, machines: [] });
    assert.equal(ec2Stub.calls.length, 0);
  });

  test("no such group -> aws_not_found", async () => {
    const { g } = group(() => ({ AutoScalingGroups: [] }));
    await rejectsCode(g.describeGroup("nope"), "aws_not_found", false);
  });

  test("throttled -> aws_throttled", async () => {
    const { g } = group(() => {
      throw awsFault("Throttling", 400);
    });
    await rejectsCode(g.describeGroup("g"), "aws_throttled", true);
  });
});

describe("setGroupDesired", () => {
  test("sends the capacity with HonorCooldown false and no token (SetDesiredCapacity has none)", async () => {
    const { g, asgStub } = group(() => ({}));
    await g.setGroupDesired("g", 1, "intent-1:0");
    await g.setGroupDesired("g", 0, "intent-2:0");
    assert.deepEqual(asgStub.sent("SetDesiredCapacityCommand"), [
      { AutoScalingGroupName: "g", DesiredCapacity: 1, HonorCooldown: false },
      { AutoScalingGroupName: "g", DesiredCapacity: 0, HonorCooldown: false },
    ]);
  });

  test("ValidationError naming a missing group -> aws_not_found; any other ValidationError stays invalid_input", async () => {
    const missing = group(() => {
      throw awsFault("ValidationError", 400, "AutoScalingGroup name not found - AutoScalingGroup 'g' not found");
    });
    await rejectsCode(missing.g.setGroupDesired("g", 1, "t"), "aws_not_found", false);
    const tooBig = group(() => {
      throw awsFault(
        "ValidationError",
        400,
        "New SetDesiredCapacity value 1 is above max value 0 for the AutoScalingGroup.",
      );
    });
    await rejectsCode(tooBig.g.setGroupDesired("g", 1, "t"), "invalid_input", false);
  });

  const rows: ReadonlyArray<readonly [string, number, string, boolean]> = [
    ["ScalingActivityInProgress", 400, "aws_conflict", true],
    ["ResourceContention", 500, "aws_conflict", true],
    ["AccessDenied", 403, "aws_denied", false],
  ];
  for (const [name, status, code, retryable] of rows) {
    test(`${name} -> ${code}`, async () => {
      const { g } = group(() => {
        throw awsFault(name, status);
      });
      await rejectsCode(g.setGroupDesired("g", 1, "t"), code, retryable);
    });
  }
});

test("makeAwsCompute joins the machine and group adapters into one Compute", async () => {
  const ec2 = ec2Client(OFFLINE_CONFIG);
  const asg = asgClient(OFFLINE_CONFIG);
  stubSdk(ec2, () => ({ Reservations: [] }));
  stubSdk(asg, () => ({ AutoScalingGroups: [] }));
  const compute = makeAwsCompute(makeAwsMachines({ ec2 }), makeAwsGroup({ asg, ec2 }));
  assert.equal(await compute.describePersistent("main"), null);
  await rejectsCode(compute.describeGroup("g"), "aws_not_found", false);
});
