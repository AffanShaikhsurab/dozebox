// The EBS adapter offline: recorded volumes parse into VolumeView, CreateVolume carries the port's token as its
// ClientToken, and moveActive checks the box tag first and clears the old volume before tagging the new one.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { awsFault, awsFixture, OFFLINE_CONFIG, stubSdk, type StubReply } from "@dozebox/testkit/wire";
import { makeAwsVolumes, toVolumeView } from "../src/adapters/aws/ebs.ts";
import { ec2Client } from "../src/adapters/aws/ec2.ts";

const volumes = (reply: StubReply) => {
  const ec2 = ec2Client(OFFLINE_CONFIG);
  const stub = stubSdk(ec2, reply);
  return { v: makeAwsVolumes({ ec2 }), stub };
};

const rejectsCode = async (p: Promise<unknown>, code: string, retryable: boolean) =>
  assert.rejects(p, (e: unknown) => e instanceof RunnerError && e.code === code && e.retryable === retryable);

const vol = (id: string, box: string, active: boolean) => ({
  VolumeId: id,
  State: "available",
  AvailabilityZone: "us-east-1a",
  Size: 8,
  Tags: [
    { Key: "dozebox:box", Value: box },
    { Key: "dozebox:active", Value: String(active) },
  ],
});

/** What a newer API version might send: values the SDK's types do not list yet. */
const raw = (o: object) => o as Parameters<typeof toVolumeView>[0];

describe("describeBox", () => {
  test("recorded volumes -> views, oldest first, filtered by the box tag", async () => {
    const { v, stub } = volumes(() => awsFixture("describe-volumes.box"));
    assert.deepEqual(await v.describeBox("main"), [
      {
        id: "vol-0a1b2c3d4e5f60001",
        state: "in-use",
        zone: "us-east-1a",
        sizeGiB: 20,
        active: true,
        attachments: [{ machineId: "i-0a1b2c3d4e5f60001", state: "attached" }],
      },
      {
        id: "vol-0a1b2c3d4e5f60002",
        state: "available",
        zone: "us-east-1a",
        sizeGiB: 20,
        active: false,
        attachments: [],
      },
    ]);
    assert.deepEqual(stub.sent("DescribeVolumesCommand")[0]?.["Filters"], [
      { Name: "tag:dozebox:box", Values: ["main"] },
    ]);
  });

  test("reads every page", async () => {
    const { v, stub } = volumes((_cmd, input) =>
      input["NextToken"] === undefined
        ? { Volumes: [vol("vol-a", "main", true)], NextToken: "p2" }
        : { Volumes: [vol("vol-b", "main", false)] },
    );
    assert.deepEqual((await v.describeBox("main")).map((x) => x.id).toSorted(), ["vol-a", "vol-b"]);
    assert.equal(stub.sent("DescribeVolumesCommand")[1]?.["NextToken"], "p2");
  });

  test("throttled -> aws_throttled", async () => {
    const { v } = volumes(() => {
      throw awsFault("RequestLimitExceeded", 503);
    });
    await rejectsCode(v.describeBox("main"), "aws_throttled", true);
  });

  test("a volume without an id or with an unknown state is a bug; unknown attachment states are dropped", () => {
    assert.throws(() => toVolumeView(raw({ State: "available" }), "dozebox"), RunnerError);
    assert.throws(() => toVolumeView(raw({ VolumeId: "vol-a", State: "optimizing" }), "dozebox"), RunnerError);
    const view = toVolumeView(
      raw({
        ...vol("vol-a", "main", false),
        Attachments: [{ InstanceId: "i-1", State: "weird" }, { State: "attached" }],
      }),
      "dozebox",
    );
    assert.deepEqual(view.attachments, []);
  });
});

describe("moveActive", () => {
  test("clears the old volume, then tags the new one", async () => {
    const { v, stub } = volumes((cmd) =>
      cmd === "DescribeVolumesCommand" ? { Volumes: [vol("vol-a", "main", true), vol("vol-b", "main", false)] } : {},
    );
    await v.moveActive("main", "vol-a", "vol-b");
    assert.deepEqual(stub.sent("CreateTagsCommand"), [
      { Resources: ["vol-a"], Tags: [{ Key: "dozebox:active", Value: "false" }] },
      { Resources: ["vol-b"], Tags: [{ Key: "dozebox:active", Value: "true" }] },
    ]);
    assert.deepEqual(
      stub.calls.map((c) => c.command),
      ["DescribeVolumesCommand", "CreateTagsCommand", "CreateTagsCommand"],
    );
  });

  test("with no previous holder it only tags the new volume", async () => {
    const { v, stub } = volumes((cmd) =>
      cmd === "DescribeVolumesCommand" ? { Volumes: [vol("vol-b", "main", false)] } : {},
    );
    await v.moveActive("main", null, "vol-b");
    assert.deepEqual(stub.sent("CreateTagsCommand"), [
      { Resources: ["vol-b"], Tags: [{ Key: "dozebox:active", Value: "true" }] },
    ]);
  });

  test("a volume of another box is refused before any tag changes", async () => {
    const { v, stub } = volumes(() => ({ Volumes: [vol("vol-a", "main", true), vol("vol-x", "other", false)] }));
    await rejectsCode(v.moveActive("main", "vol-a", "vol-x"), "invalid_input", false);
    assert.equal(stub.sent("CreateTagsCommand").length, 0);
  });

  test("a failed clear stops the move: never two active volumes", async () => {
    const { v, stub } = volumes((cmd) => {
      if (cmd === "DescribeVolumesCommand")
        return { Volumes: [vol("vol-a", "main", true), vol("vol-b", "main", false)] };
      throw awsFault("RequestLimitExceeded", 503);
    });
    await rejectsCode(v.moveActive("main", "vol-a", "vol-b"), "aws_throttled", true);
    assert.equal(stub.sent("CreateTagsCommand").length, 1);
  });

  test("a missing volume -> aws_not_found", async () => {
    const { v } = volumes(() => {
      throw awsFault("InvalidVolume.NotFound", 400);
    });
    await rejectsCode(v.moveActive("main", null, "vol-gone"), "aws_not_found", false);
  });
});

describe("createFromSnapshot", () => {
  test("sends the port's token as ClientToken, encrypted gp3, tagged to the box and inactive", async () => {
    const { v, stub } = volumes(() => ({ VolumeId: "vol-new" }));
    const id = await v.createFromSnapshot({
      boxId: "main",
      snapshotId: "snap-1",
      zone: "us-east-1a",
      token: "restore-7",
    });
    assert.equal(id, "vol-new");
    assert.deepEqual(stub.sent("CreateVolumeCommand"), [
      {
        SnapshotId: "snap-1",
        AvailabilityZone: "us-east-1a",
        VolumeType: "gp3",
        Encrypted: true,
        ClientToken: "restore-7",
        TagSpecifications: [
          {
            ResourceType: "volume",
            Tags: [
              { Key: "dozebox:box", Value: "main" },
              { Key: "dozebox:active", Value: "false" },
            ],
          },
        ],
      },
    ]);
  });

  test("a retry with the same token sends the same token (AWS returns the same volume)", async () => {
    const { v, stub } = volumes(() => ({ VolumeId: "vol-new" }));
    const opts = { boxId: "main", snapshotId: "snap-1", zone: "us-east-1a", token: "restore-7" };
    assert.equal(await v.createFromSnapshot(opts), await v.createFromSnapshot(opts));
    assert.deepEqual(
      stub.sent("CreateVolumeCommand").map((i) => i["ClientToken"]),
      ["restore-7", "restore-7"],
    );
  });

  const rows: ReadonlyArray<readonly [string, number, string, boolean]> = [
    ["InvalidSnapshot.NotFound", 400, "aws_not_found", false],
    ["VolumeLimitExceeded", 400, "aws_limit", false],
    ["IdempotentParameterMismatch", 400, "invalid_input", false],
  ];
  for (const [name, status, code, retryable] of rows) {
    test(`${name} -> ${code}`, async () => {
      const { v } = volumes(() => {
        throw awsFault(name, status);
      });
      await rejectsCode(
        v.createFromSnapshot({ boxId: "main", snapshotId: "snap-1", zone: "us-east-1a", token: "t" }),
        code,
        retryable,
      );
    });
  }

  test("an answer without a volume id is a bug", async () => {
    const { v } = volumes(() => ({}));
    await rejectsCode(
      v.createFromSnapshot({ boxId: "main", snapshotId: "s", zone: "z", token: "t" }),
      "internal",
      false,
    );
  });
});

const attached = (id: string, box: string, active: boolean, machine: string, state = "attached") => ({
  ...vol(id, box, active),
  State: "in-use",
  Attachments: [{ InstanceId: machine, State: state }],
});

describe("detach", () => {
  test("detaches from the machine, without Force", async () => {
    const { v, stub } = volumes((cmd) =>
      cmd === "DescribeVolumesCommand" ? { Volumes: [attached("vol-a", "main", true, "i-1")] } : {},
    );
    await v.detach("vol-a", "i-1", "tok");
    assert.deepEqual(stub.sent("DetachVolumeCommand"), [{ VolumeId: "vol-a", InstanceId: "i-1" }]);
  });

  test("not attached to that machine, or already detaching -> no call", async () => {
    for (const volume of [
      vol("vol-a", "main", true),
      attached("vol-a", "main", true, "i-other"),
      attached("vol-a", "main", true, "i-1", "detaching"),
    ]) {
      const { v, stub } = volumes(() => ({ Volumes: [volume] }));
      await v.detach("vol-a", "i-1", "tok");
      assert.equal(stub.sent("DetachVolumeCommand").length, 0);
    }
  });

  test("a missing volume -> aws_not_found; detached in between -> success", async () => {
    const gone = volumes(() => {
      throw awsFault("InvalidVolume.NotFound", 400);
    });
    await rejectsCode(gone.v.detach("vol-a", "i-1", "tok"), "aws_not_found", false);
    const raced = volumes((cmd) => {
      if (cmd === "DescribeVolumesCommand") return { Volumes: [attached("vol-a", "main", true, "i-1")] };
      throw awsFault("InvalidAttachment.NotFound", 400);
    });
    await raced.v.detach("vol-a", "i-1", "tok");
  });
});

const snap = (id: string, at: number) => ({ SnapshotId: id, StartTime: new Date(at), VolumeSize: 8 });

describe("newestSnapshot", () => {
  test("asks for the account's completed snapshots of the box and returns the newest, across pages", async () => {
    const { v, stub } = volumes((_cmd, input) =>
      input["NextToken"] === undefined
        ? { Snapshots: [snap("snap-old", 1_000), snap("snap-new", 3_000)], NextToken: "p2" }
        : { Snapshots: [snap("snap-mid", 2_000)] },
    );
    assert.deepEqual(await v.newestSnapshot("main"), { id: "snap-new", startedAt: 3_000, sizeGiB: 8 });
    const sent = stub.sent("DescribeSnapshotsCommand")[0];
    assert.deepEqual(sent?.["OwnerIds"], ["self"]);
    assert.deepEqual(sent?.["Filters"], [
      { Name: "tag:dozebox:box", Values: ["main"] },
      { Name: "status", Values: ["completed"] },
    ]);
  });

  test("none -> null; throttled -> aws_throttled", async () => {
    assert.equal(await volumes(() => ({ Snapshots: [] })).v.newestSnapshot("main"), null);
    const { v } = volumes(() => {
      throw awsFault("RequestLimitExceeded", 503);
    });
    await rejectsCode(v.newestSnapshot("main"), "aws_throttled", true);
  });
});

describe("deleteVolume", () => {
  test("deletes an inactive, unattached volume of a box", async () => {
    const { v, stub } = volumes((cmd) =>
      cmd === "DescribeVolumesCommand" ? { Volumes: [vol("vol-a", "main", false)] } : {},
    );
    await v.deleteVolume("vol-a", "tok");
    assert.deepEqual(stub.sent("DeleteVolumeCommand"), [{ VolumeId: "vol-a" }]);
  });

  test("a missing or already deleting volume succeeds without a delete", async () => {
    const gone = volumes(() => {
      throw awsFault("InvalidVolume.NotFound", 400);
    });
    await gone.v.deleteVolume("vol-a", "tok");
    const deleting = volumes(() => ({ Volumes: [{ ...vol("vol-a", "main", false), State: "deleting" }] }));
    await deleting.v.deleteVolume("vol-a", "tok");
    assert.equal(deleting.stub.sent("DeleteVolumeCommand").length, 0);
  });

  test("the volume disappearing before the delete is success", async () => {
    const { v } = volumes((cmd) => {
      if (cmd === "DescribeVolumesCommand") return { Volumes: [vol("vol-a", "main", false)] };
      throw awsFault("InvalidVolume.NotFound", 400);
    });
    await v.deleteVolume("vol-a", "tok");
  });

  test("refuses an active volume and one without the box tag (invalid_input), an attached one (aws_conflict)", async () => {
    const cases: ReadonlyArray<readonly [object, string, boolean]> = [
      [vol("vol-a", "main", true), "invalid_input", false],
      [{ ...vol("vol-a", "main", false), Tags: [] }, "invalid_input", false],
      [attached("vol-a", "main", false, "i-1"), "aws_conflict", true],
    ];
    for (const [volume, code, retryable] of cases) {
      const { v, stub } = volumes(() => ({ Volumes: [volume] }));
      await rejectsCode(v.deleteVolume("vol-a", "tok"), code, retryable);
      assert.equal(stub.sent("DeleteVolumeCommand").length, 0);
    }
  });
});
