// The agent's self-stop adapter offline: the right call for each mode, no token, and error mapping.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { awsFault, OFFLINE_CONFIG, stubSdk, type StubReply } from "@dozebox/testkit/wire";
import { asgClient, ec2Client, makeAwsSelfStop } from "../src/adapters/aws/ec2.ts";

const selfStop = (ec2Reply: StubReply, asgReply: StubReply = () => undefined) => {
  const ec2 = ec2Client(OFFLINE_CONFIG);
  const asg = asgClient(OFFLINE_CONFIG);
  const ec2Stub = stubSdk(ec2, ec2Reply);
  const asgStub = stubSdk(asg, asgReply);
  return { s: makeAwsSelfStop({ ec2, asg }), ec2Stub, asgStub };
};

const rejectsCode = async (p: Promise<unknown>, code: string, retryable: boolean) =>
  assert.rejects(p, (e: unknown) => e instanceof RunnerError && e.code === code && e.retryable === retryable);

test("persistent mode stops its own instance and touches no group", async () => {
  const { s, ec2Stub, asgStub } = selfStop(() => ({ StoppingInstances: [] }));
  await s.stopSelf({ mode: "persistent", instanceId: "i-1" });
  assert.deepEqual(ec2Stub.sent("StopInstancesCommand"), [{ InstanceIds: ["i-1"] }]);
  assert.equal(asgStub.calls.length, 0);
});

test("group mode sets its group to 0 without cooldown, and does not stop the instance", async () => {
  const { s, ec2Stub, asgStub } = selfStop(
    () => undefined,
    () => ({}),
  );
  await s.stopSelf({ mode: "group", instanceId: "i-2", groupName: "dozebox-main-fallback" });
  assert.deepEqual(asgStub.sent("SetDesiredCapacityCommand"), [
    { AutoScalingGroupName: "dozebox-main-fallback", DesiredCapacity: 0, HonorCooldown: false },
  ]);
  assert.equal(ec2Stub.calls.length, 0);
});

test("a missing group -> aws_not_found", async () => {
  const { s } = selfStop(
    () => undefined,
    () => {
      throw awsFault("ValidationError", 400, "AutoScalingGroup name not found - AutoScalingGroup 'g' not found");
    },
  );
  await rejectsCode(s.stopSelf({ mode: "group", instanceId: "i-2", groupName: "g" }), "aws_not_found", false);
});

test("errors map through fromAws in both modes", async () => {
  const persistent = selfStop(() => {
    throw awsFault("IncorrectInstanceState", 400);
  });
  await rejectsCode(persistent.s.stopSelf({ mode: "persistent", instanceId: "i-1" }), "aws_conflict", true);
  const group = selfStop(
    () => undefined,
    () => {
      throw awsFault("ValidationError", 400, "New SetDesiredCapacity value 0 is below min value 1");
    },
  );
  await rejectsCode(group.s.stopSelf({ mode: "group", instanceId: "i-2", groupName: "g" }), "invalid_input", false);
  const denied = selfStop(() => {
    throw awsFault("UnauthorizedOperation", 403);
  });
  await rejectsCode(denied.s.stopSelf({ mode: "persistent", instanceId: "i-1" }), "aws_denied", false);
});
