// FakeAws behaviour the reconciler depends on that the shared contracts cannot ask of the emulator.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { rejectsWith } from "../src/contracts/support.ts";
import { makeFakeAws } from "../src/fakes/index.ts";

const spotBox = () => {
  const aws = makeFakeAws({ ec2Timing: { bootMs: 30_000, stopMs: 60_000, spotSettleMs: 10_000 } });
  const id = aws.ec2.addMachine({ boxId: "b1", role: "persistent", state: "running", lifecycle: "spot" });
  return { aws, id };
};

test("a stale describe returns the state as of N seconds ago (the stale-describe fault)", async () => {
  const { aws, id } = spotBox();
  aws.clock.advance(60_000);
  await aws.compute.stopPersistent(id, "t");
  aws.clock.advance(1_000);
  aws.ec2.setStaleness(30_000);
  assert.equal((await aws.compute.describePersistent("b1"))?.state, "running", "30 s stale: before the stop");
  aws.ec2.setStaleness(0);
  assert.equal((await aws.compute.describePersistent("b1"))?.state, "stopping");
  aws.ec2.setStaleness(10 * 60_000);
  assert.equal(await aws.compute.describePersistent("b1"), null, "older than the machine: not there yet");
});

test("a persistent Spot request: marked-for-stop through the stop, then disabled, then active on start", async () => {
  const { aws, id } = spotBox();
  assert.equal(aws.ec2.machine(id)?.spotRequest, "active");
  aws.clock.advance(1_500);
  await aws.compute.stopPersistent(id, "t");
  assert.deepEqual([aws.ec2.machine(id)?.state, aws.ec2.machine(id)?.spotRequest], ["stopping", "marked-for-stop"]);
  assert.equal(aws.ec2.machine(id)?.stoppingAt, Math.floor(aws.clock.now() / 1000) * 1000);
  await rejectsWith(aws.compute.startPersistent(id, "t"), "aws_conflict", true);
  aws.clock.advance(60_000);
  assert.deepEqual([aws.ec2.machine(id)?.state, aws.ec2.machine(id)?.spotRequest], ["stopped", "marked-for-stop"]);
  await assert.rejects(aws.compute.startPersistent(id, "t"), /IncorrectSpotRequestState/);
  aws.clock.advance(10_000);
  assert.equal(aws.ec2.machine(id)?.spotRequest, "disabled");
  await aws.compute.startPersistent(id, "intent-9:0");
  assert.deepEqual([aws.ec2.machine(id)?.state, aws.ec2.machine(id)?.spotRequest], ["pending", "active"]);
  aws.clock.advance(30_000);
  assert.equal(aws.ec2.machine(id)?.state, "running");
  assert.deepEqual(
    aws.ec2.calls.map((c) => [c.op, c.token]),
    [
      ["stop", "t"],
      ["start", "t"],
      ["start", "t"],
      ["start", "intent-9:0"],
    ],
  );
});

test("no Spot capacity: start fails with aws_capacity and the machine stays stopped", async () => {
  const aws = makeFakeAws();
  const id = aws.ec2.addMachine({ boxId: "b1", role: "persistent", state: "stopped", lifecycle: "spot" });
  aws.ec2.setSpotCapacity(false);
  await rejectsWith(aws.compute.startPersistent(id, "t"), "aws_capacity", true);
  assert.equal(aws.ec2.machine(id)?.state, "stopped");
});

test("an On-Demand machine has no Spot request; stopping a pending one is a conflict", async () => {
  const aws = makeFakeAws();
  const id = aws.ec2.addMachine({ boxId: "b1", role: "persistent", state: "stopped", lifecycle: "on-demand" });
  await aws.compute.startPersistent(id, "t");
  assert.equal(aws.ec2.machine(id)?.spotRequest, "none");
  await rejectsWith(aws.compute.stopPersistent(id, "t"), "aws_conflict", true);
});

test("describePersistent prefers a live machine over a terminated older one", async () => {
  const aws = makeFakeAws();
  const old = aws.ec2.addMachine({ boxId: "b1", role: "persistent", state: "running", lifecycle: "spot" });
  aws.ec2.terminate(old);
  aws.clock.advance(120_000);
  assert.equal((await aws.compute.describePersistent("b1"))?.state, "terminated");
  const fresh = aws.ec2.addMachine({ boxId: "b1", role: "persistent", state: "stopped", lifecycle: "spot" });
  assert.equal((await aws.compute.describePersistent("b1"))?.id, fresh);
  await rejectsWith(aws.compute.startPersistent(old, "t"), "aws_conflict");
});

test("the group launches one machine on raise, terminates it on lower, and launches none without capacity", async () => {
  const aws = makeFakeAws();
  aws.asg.addGroup("g", { boxId: "b1" });
  await aws.compute.setGroupDesired("g", 1, "a");
  const [m] = (await aws.compute.describeGroup("g")).machines;
  assert.deepEqual([m?.state, m?.lifecycle], ["pending", "on-demand"]);
  await aws.compute.setGroupDesired("g", 1, "a");
  assert.equal((await aws.compute.describeGroup("g")).machines.length, 1, "a second raise launches nothing");
  await aws.compute.setGroupDesired("g", 0, "b");
  assert.equal((await aws.compute.describeGroup("g")).machines[0]?.state, "shutting-down");
  aws.clock.advance(60_000);
  assert.deepEqual(await aws.compute.describeGroup("g"), { desired: 0, machines: [] });
  aws.asg.setCapacity(false);
  await aws.compute.setGroupDesired("g", 1, "c");
  assert.deepEqual(await aws.compute.describeGroup("g"), { desired: 1, machines: [] });
  assert.deepEqual(
    aws.asg.calls.map((c) => c.token),
    ["a", "a", "b", "c"],
  );
});

test("selfStop: persistent stops the machine (twice is fine); group mode lowers the group", async () => {
  const aws = makeFakeAws();
  const id = aws.ec2.addMachine({ boxId: "b1", role: "persistent", state: "running", lifecycle: "spot" });
  await aws.selfStop.stopSelf({ mode: "persistent", instanceId: id });
  await aws.selfStop.stopSelf({ mode: "persistent", instanceId: id });
  assert.equal(aws.ec2.machine(id)?.state, "stopping");
  aws.asg.addGroup("g", { boxId: "b1" });
  await aws.compute.setGroupDesired("g", 1, "t");
  const [m] = (await aws.compute.describeGroup("g")).machines;
  assert.ok(m);
  await aws.selfStop.stopSelf({ mode: "group", instanceId: m.id, groupName: "g" });
  assert.equal((await aws.compute.describeGroup("g")).desired, 0);
});

test("EBS: two active volumes is an error, a reused token with other parameters is refused, zones must match", async () => {
  const aws = makeFakeAws();
  aws.ebs.addVolume({ boxId: "b1", active: true });
  aws.ebs.addVolume({ boxId: "b1", active: true });
  await assert.rejects(
    aws.ebs.attach.findActive("b1"),
    (e: unknown) => e instanceof RunnerError && e.code === "internal",
  );
  const snap = aws.ebs.addSnapshot({ sizeGiB: 20 });
  const id = await aws.ebs.volumes.createFromSnapshot({
    boxId: "b2",
    snapshotId: snap,
    zone: "us-east-1a",
    token: "k",
  });
  await rejectsWith(
    aws.ebs.volumes.createFromSnapshot({ boxId: "b2", snapshotId: snap, zone: "us-east-1b", token: "k" }),
    "invalid_input",
  );
  assert.equal((await aws.ebs.volumes.describeBox("b2"))[0]?.state, "creating");
  assert.equal((await aws.ebs.volumes.describeBox("b2"))[0]?.sizeGiB, 20);
  await aws.ebs.volumes.moveActive("b2", null, id);
  const m = aws.ec2.addMachine({
    boxId: "b2",
    role: "persistent",
    state: "running",
    lifecycle: "spot",
    zone: "us-east-1b",
  });
  await rejectsWith(
    aws.ebs.attach.attach({ boxId: "b2", volumeId: id, machineId: m, device: "/dev/sdf" }),
    "invalid_input",
  );
  await rejectsWith(aws.ebs.volumes.moveActive("b3", null, id), "invalid_input");
});

test("EBS: attach waits for creating, is idempotent for the same machine, and refuses a second machine", async () => {
  const aws = makeFakeAws();
  const snap = aws.ebs.addSnapshot();
  const vol = await aws.ebs.volumes.createFromSnapshot({
    boxId: "b1",
    snapshotId: snap,
    zone: "us-east-1a",
    token: "k",
  });
  await aws.ebs.volumes.moveActive("b1", null, vol);
  const a = aws.ec2.addMachine({ boxId: "b1", role: "persistent", state: "running", lifecycle: "spot" });
  const b = aws.ec2.addMachine({ boxId: "x", role: "persistent", state: "running", lifecycle: "spot" });
  const attach = (machineId: string) =>
    aws.ebs.attach.attach({ boxId: "b1", volumeId: vol, machineId, device: "/dev/sdf" });
  await rejectsWith(attach(a), "aws_conflict", true);
  aws.clock.advance(5_000);
  await attach(a);
  await attach(a);
  await rejectsWith(attach(b), "aws_conflict", true);
  await rejectsWith(attach("i-0000000000000dead"), "aws_not_found");
});

test("SNS records what was published; Logs sorts events and needs the group to exist", async () => {
  const aws = makeFakeAws();
  const id = await aws.sns.notifier.publish({ subject: "s", body: "b", attributes: { severity: "page" } });
  assert.deepEqual(aws.sns.published, [{ subject: "s", body: "b", attributes: { severity: "page" }, id }]);
  await rejectsWith(aws.logs.transport.send("/dozebox/b1/box", "s", [{ at: 1, message: "x" }]), "aws_not_found");
  aws.logs.addGroup("/dozebox/b1/box");
  const n = await aws.logs.transport.send("/dozebox/b1/box", "s", [
    { at: 2, message: "second" },
    { at: 1, message: "first" },
  ]);
  assert.equal(n, 2);
  assert.deepEqual(
    aws.logs.events("/dozebox/b1/box", "s").map((e) => e.message),
    ["first", "second"],
  );
});

test("SSM keeps each record's tier", async () => {
  const aws = makeFakeAws();
  const store = aws.ssm.store("/dozebox/b1/");
  await store.put("rec/liveness", "{}", { tier: "Advanced" });
  assert.deepEqual(aws.ssm.parameters().get("/dozebox/b1/rec/liveness"), { value: "{}", tier: "Advanced" });
});
