// The EC2 adapter offline: recorded describes parse into MachineView, the persistent machine is picked from the
// right reads, Spot requests not visible yet read as none, and no call carries a client token it does not have.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { awsFault, awsFixture, OFFLINE_CONFIG, stubSdk, type StubReply } from "@dozebox/testkit/wire";
import { ec2Client, makeAwsMachines, parseTransitionTime, spotRequestOf } from "../src/adapters/aws/ec2.ts";

const machines = (reply: StubReply) => {
  const ec2 = ec2Client(OFFLINE_CONFIG);
  const stub = stubSdk(ec2, reply);
  return { m: makeAwsMachines({ ec2 }), stub };
};

const rejectsCode = async (p: Promise<unknown>, code: string, retryable: boolean) =>
  assert.rejects(p, (e: unknown) => e instanceof RunnerError && e.code === code && e.retryable === retryable);

describe("parseTransitionTime", () => {
  const rows: ReadonlyArray<readonly [string, string | undefined, number | null]> = [
    ["user stop", "User initiated (2026-11-24 21:00:05 GMT)", Date.UTC(2026, 10, 24, 21, 0, 5)],
    ["service stop", "Service initiated (2026-11-24 22:15:41 GMT)", Date.UTC(2026, 10, 24, 22, 15, 41)],
    ["emulator writes UTC", "User initiated (2026-11-25 07:24:52 UTC)", Date.UTC(2026, 10, 25, 7, 24, 52)],
    ["running, empty", "", null],
    ["missing", undefined, null],
    ["no time in the text", "Server.SpotInstanceShutdown: Spot instance shutdown", null],
    ["impossible date", "User initiated (2026-13-45 99:00:00 GMT)", null],
  ];
  for (const [name, reason, want] of rows) {
    test(name, () => assert.equal(parseTransitionTime(reason), want));
  }
});

describe("spotRequestOf", () => {
  const rows: ReadonlyArray<readonly [string, Parameters<typeof spotRequestOf>[0], string]> = [
    ["no request", null, "none"],
    ["active", { State: "active", Status: { Code: "fulfilled" } }, "active"],
    ["open, waiting for capacity", { State: "open", Status: { Code: "capacity-not-available" } }, "active"],
    ["stopped by user", { State: "disabled", Status: { Code: "instance-stopped-by-user" } }, "disabled"],
    [
      "marked for stop wins over the state",
      { State: "active", Status: { Code: "marked-for-stop" } },
      "marked-for-stop",
    ],
    ["cancelled", { State: "cancelled", Status: { Code: "canceled-before-fulfillment" } }, "none"],
  ];
  for (const [name, req, want] of rows) {
    test(name, () => assert.equal(spotRequestOf(req), want));
  }
});

const inst = (id: string, state: string, launched: string) => ({
  InstanceId: id,
  State: { Name: state },
  LaunchTime: new Date(launched),
});
const gone = (id: string, launched: string) => ({
  InstanceId: id,
  State: { Name: "terminated" },
  LaunchTime: new Date(launched),
  StateTransitionReason: "User initiated (2026-11-20 09:12:44 GMT)",
});

describe("describePersistent", () => {
  test("recorded stopped Spot machine -> MachineView with the stop time to the second", async () => {
    const { m, stub } = machines((cmd) =>
      cmd === "DescribeInstancesCommand"
        ? awsFixture("describe-instances.persistent")
        : awsFixture("describe-spot-instance-requests.disabled"),
    );
    assert.deepEqual(await m.describePersistent("main"), {
      id: "i-0a1b2c3d4e5f60001",
      state: "stopped",
      lifecycle: "spot",
      launchedAt: Date.UTC(2026, 10, 24, 20, 10, 3),
      stoppingAt: Date.UTC(2026, 10, 24, 21, 0, 5),
      spotRequest: "disabled",
      type: "t4g.medium",
      zone: "us-east-1a",
    });
    assert.deepEqual(stub.sent("DescribeInstancesCommand")[0]?.["Filters"], [
      { Name: "tag:dozebox:box", Values: ["main"] },
      { Name: "tag:dozebox:role", Values: ["persistent"] },
    ]);
    assert.deepEqual(stub.sent("DescribeSpotInstanceRequestsCommand")[0]?.["SpotInstanceRequestIds"], ["sir-abcd1234"]);
  });

  test("recorded Spot interruption -> stopping, marked-for-stop, stoppingAt from the service stop", async () => {
    const { m } = machines((cmd) =>
      cmd === "DescribeInstancesCommand"
        ? awsFixture("describe-instances.spot-interrupted")
        : awsFixture("describe-spot-instance-requests.marked-for-stop"),
    );
    const v = await m.describePersistent("main");
    assert.deepEqual(
      [v?.state, v?.spotRequest, v?.stoppingAt],
      ["stopping", "marked-for-stop", Date.UTC(2026, 10, 24, 22, 15, 41)],
    );
  });

  test("recorded On-Demand running machine -> no stop time, no Spot request, no Spot read", async () => {
    const { m, stub } = machines(() => awsFixture("describe-instances.on-demand-running"));
    const v = await m.describePersistent("main");
    assert.deepEqual([v?.state, v?.lifecycle, v?.stoppingAt, v?.spotRequest], ["running", "on-demand", null, "none"]);
    assert.equal(stub.sent("DescribeSpotInstanceRequestsCommand").length, 0);
  });

  test("reads every page, and prefers the newest live machine over a newer terminated one", async () => {
    const { m, stub } = machines((cmd, input) => {
      if (cmd !== "DescribeInstancesCommand") return undefined;
      return input["NextToken"] === undefined
        ? { Reservations: [{ Instances: [inst("i-old", "stopped", "2026-11-01T00:00:00Z")] }], NextToken: "p2" }
        : { Reservations: [{ Instances: [inst("i-gone", "terminated", "2026-11-20T00:00:00Z")] }] };
    });
    assert.equal((await m.describePersistent("main"))?.id, "i-old");
    assert.equal(stub.sent("DescribeInstancesCommand").length, 2);
  });

  test("only terminated machines -> the newest of them; none -> null", async () => {
    const { m } = machines(() => ({
      Reservations: [{ Instances: [gone("i-a", "2026-11-01T00:00:00Z"), gone("i-b", "2026-11-02T00:00:00Z")] }],
    }));
    const { m: empty } = machines(() => ({ Reservations: [] }));
    assert.equal(await empty.describePersistent("main"), null);
    assert.deepEqual(await m.describePersistent("main"), {
      id: "i-b",
      state: "terminated",
      lifecycle: "on-demand",
      launchedAt: Date.UTC(2026, 10, 2),
      stoppingAt: Date.UTC(2026, 10, 20, 9, 12, 44),
      spotRequest: "none",
    });
  });

  test("a Spot request not visible yet (eventual consistency) reads as none", async () => {
    const { m } = machines((cmd) => {
      if (cmd === "DescribeInstancesCommand") return awsFixture("describe-instances.persistent");
      throw awsFault("InvalidSpotInstanceRequestID.NotFound", 400);
    });
    assert.equal((await m.describePersistent("main"))?.spotRequest, "none");
  });

  test("a throttled Spot read fails the describe as aws_throttled", async () => {
    const { m } = machines((cmd) => {
      if (cmd === "DescribeInstancesCommand") return awsFixture("describe-instances.persistent");
      throw awsFault("RequestLimitExceeded", 503);
    });
    await rejectsCode(m.describePersistent("main"), "aws_throttled", true);
  });

  test("an instance in a state the port does not know is a bug, not a view", async () => {
    const { m } = machines(() => ({
      Reservations: [{ Instances: [{ InstanceId: "i-1", State: { Name: "rebooting" } }] }],
    }));
    await rejectsCode(m.describePersistent("main"), "internal", false);
  });

  test("a custom prefix changes the tag filters", async () => {
    const ec2 = ec2Client(OFFLINE_CONFIG);
    const stub = stubSdk(ec2, () => ({ Reservations: [] }));
    await makeAwsMachines({ ec2, prefix: "acme" }).describePersistent("b1");
    assert.equal(
      (stub.sent("DescribeInstancesCommand")[0]?.["Filters"] as Array<{ Name: string }> | undefined)?.[0]?.Name,
      "tag:acme:box",
    );
  });
});

describe("startPersistent and stopPersistent", () => {
  test("send only the instance id: neither API has a client token", async () => {
    const { m, stub } = machines(() => ({}));
    await m.startPersistent("i-1", "intent-1:0");
    await m.stopPersistent("i-1", "intent-1:0");
    assert.deepEqual(stub.sent("StartInstancesCommand"), [{ InstanceIds: ["i-1"] }]);
    assert.deepEqual(stub.sent("StopInstancesCommand"), [{ InstanceIds: ["i-1"] }]);
  });

  const rows: ReadonlyArray<readonly [string, number, string, boolean]> = [
    ["IncorrectSpotRequestState", 400, "aws_conflict", true],
    ["IncorrectInstanceState", 400, "aws_conflict", true],
    ["InsufficientInstanceCapacity", 500, "aws_capacity", true],
    ["InvalidInstanceID.NotFound", 400, "aws_not_found", false],
    ["UnauthorizedOperation", 403, "aws_denied", false],
    ["InternalError", 500, "aws_unavailable", true],
  ];
  for (const [name, status, code, retryable] of rows) {
    test(`${name} -> ${code}`, async () => {
      const { m } = machines(() => {
        throw awsFault(name, status);
      });
      await rejectsCode(m.startPersistent("i-1", "t"), code, retryable);
      await rejectsCode(m.stopPersistent("i-1", "t"), code, retryable);
    });
  }
});
