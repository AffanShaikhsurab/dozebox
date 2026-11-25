// The agent's volume attach adapter offline: the tag fence on a fresh read, no second attach, missing volumes, and
// error mapping.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { awsFault, awsFixture, OFFLINE_CONFIG, stubSdk, type StubReply } from "@dozebox/testkit/wire";
import { makeAwsVolumeAttach } from "../src/adapters/aws/ebs.ts";
import { ec2Client } from "../src/adapters/aws/ec2.ts";

const attacher = (reply: StubReply) => {
  const ec2 = ec2Client(OFFLINE_CONFIG);
  const stub = stubSdk(ec2, reply);
  return { a: makeAwsVolumeAttach({ ec2 }), stub };
};

const rejectsCode = async (p: Promise<unknown>, code: string, retryable: boolean) =>
  assert.rejects(p, (e: unknown) => e instanceof RunnerError && e.code === code && e.retryable === retryable);

const vol = (box: string, active: boolean, attachments: ReadonlyArray<{ InstanceId: string; State: string }> = []) => ({
  VolumeId: "vol-a",
  State: attachments.length ? "in-use" : "available",
  AvailabilityZone: "us-east-1a",
  Attachments: attachments,
  Tags: [
    { Key: "dozebox:box", Value: box },
    { Key: "dozebox:active", Value: String(active) },
  ],
});

const req = { boxId: "main", volumeId: "vol-a", machineId: "i-1", device: "/dev/sdf" };

describe("findActive and describe", () => {
  test("filters by box and active tags; the attached volume reads with its attachment", async () => {
    const recorded = awsFixture("describe-volumes.box") as { Volumes: ReadonlyArray<{ VolumeId: string }> };
    const { a, stub } = attacher(() => ({ Volumes: recorded.Volumes.filter((v) => v.VolumeId.endsWith("1")) }));
    assert.deepEqual(await a.findActive("main"), {
      id: "vol-0a1b2c3d4e5f60001",
      zone: "us-east-1a",
      active: true,
      attachment: { machineId: "i-0a1b2c3d4e5f60001", state: "attached" },
    });
    assert.deepEqual(stub.sent("DescribeVolumesCommand")[0]?.["Filters"], [
      { Name: "tag:dozebox:box", Values: ["main"] },
      { Name: "tag:dozebox:active", Values: ["true"] },
    ]);
  });

  test("no active volume -> null; two active volumes -> a bug, not a pick", async () => {
    const none = attacher(() => ({ Volumes: [] }));
    assert.equal(await none.a.findActive("main"), null);
    const two = attacher(() => ({ Volumes: [vol("main", true), { ...vol("main", true), VolumeId: "vol-b" }] }));
    await rejectsCode(two.a.findActive("main"), "internal", false);
  });

  test("a detached attachment is no attachment", async () => {
    const { a } = attacher(() => ({ Volumes: [vol("main", true, [{ InstanceId: "i-old", State: "detached" }])] }));
    assert.equal((await a.describe("vol-a"))?.attachment, null);
  });

  test("describe of a missing volume is null; a throttled describe is an error", async () => {
    const missing = attacher(() => {
      throw awsFault("InvalidVolume.NotFound", 400);
    });
    assert.equal(await missing.a.describe("vol-gone"), null);
    const throttled = attacher(() => {
      throw awsFault("RequestLimitExceeded", 503);
    });
    await rejectsCode(throttled.a.describe("vol-a"), "aws_throttled", true);
    await rejectsCode(throttled.a.findActive("main"), "aws_throttled", true);
  });
});

describe("attach", () => {
  test("the box's active volume is attached as the device", async () => {
    const { a, stub } = attacher((cmd) => (cmd === "DescribeVolumesCommand" ? { Volumes: [vol("main", true)] } : {}));
    await a.attach(req);
    assert.deepEqual(stub.sent("AttachVolumeCommand"), [{ VolumeId: "vol-a", InstanceId: "i-1", Device: "/dev/sdf" }]);
  });

  test("the tag fence: an inactive volume or another box's volume is refused without an AttachVolume", async () => {
    for (const v of [vol("main", false), vol("other", true)]) {
      const { a, stub } = attacher(() => ({ Volumes: [v] }));
      await rejectsCode(a.attach(req), "aws_denied", false);
      assert.equal(stub.sent("AttachVolumeCommand").length, 0);
    }
  });

  test("already attaching or attached to this machine -> no second AttachVolume", async () => {
    for (const State of ["attaching", "attached"]) {
      const { a, stub } = attacher(() => ({ Volumes: [vol("main", true, [{ InstanceId: "i-1", State }])] }));
      await a.attach(req);
      assert.equal(stub.sent("AttachVolumeCommand").length, 0);
    }
  });

  test("a missing volume -> aws_not_found", async () => {
    const { a } = attacher(() => ({ Volumes: [] }));
    await rejectsCode(a.attach(req), "aws_not_found", false);
  });

  const rows: ReadonlyArray<readonly [string, number, string, boolean]> = [
    ["VolumeInUse", 400, "aws_conflict", true],
    ["IncorrectState", 400, "aws_conflict", true],
    ["InvalidVolume.ZoneMismatch", 400, "invalid_input", false],
    ["UnauthorizedOperation", 403, "aws_denied", false],
  ];
  for (const [name, status, code, retryable] of rows) {
    test(`AttachVolume failing with ${name} -> ${code}`, async () => {
      const { a } = attacher((cmd) => {
        if (cmd === "DescribeVolumesCommand") return { Volumes: [vol("main", true)] };
        throw awsFault(name, status);
      });
      await rejectsCode(a.attach(req), code, retryable);
    });
  }
});
