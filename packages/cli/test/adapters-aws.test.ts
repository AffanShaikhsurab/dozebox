// The CLI's AWS adapter on stubbed SDK clients: request shapes, mapping, and error handling.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { EC2Client } from "@aws-sdk/client-ec2";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { SNSClient } from "@aws-sdk/client-sns";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { RunnerError } from "@dozebox/core/errors";
import { awsFault, OFFLINE_CONFIG, stubSdk, type StubReply } from "@dozebox/testkit/wire";
import { makeAwsOps } from "../src/adapters/aws/ops.ts";

const none: StubReply = (command) => {
  throw new Error(`unexpected ${command}`);
};

/** `all` answers every client that has no reply of its own. */
function setup(replies: { ec2?: StubReply; ssm?: StubReply; all?: StubReply } = {}) {
  const c = {
    ec2: new EC2Client(OFFLINE_CONFIG),
    ssm: new SSMClient(OFFLINE_CONFIG),
    sts: new STSClient(OFFLINE_CONFIG),
    lambda: new LambdaClient(OFFLINE_CONFIG),
    ce: new CostExplorerClient(OFFLINE_CONFIG),
    quotas: new ServiceQuotasClient(OFFLINE_CONFIG),
    sns: new SNSClient(OFFLINE_CONFIG),
  };
  const all = replies.all ?? none;
  const stubs = {
    ec2: stubSdk(c.ec2, replies.ec2 ?? all),
    ssm: stubSdk(c.ssm, replies.ssm ?? all),
    sts: stubSdk(c.sts, all),
    lambda: stubSdk(c.lambda, all),
    ce: stubSdk(c.ce, all),
    quotas: stubSdk(c.quotas, all),
    sns: stubSdk(c.sns, all),
  };
  const ops = makeAwsOps({ region: "eu-west-1", tagPrefix: "dozebox", sharedPath: "/dozebox/shared/", clients: c });
  return { ops, stubs };
}

const rejectsCode = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof RunnerError && e.code === code);

const denied: StubReply = () => {
  throw awsFault("AccessDeniedException", 403);
};

const snap = (id: string, state: string, t: number, label?: string) => ({
  SnapshotId: id,
  VolumeId: "vol-1",
  State: state,
  StartTime: new Date(t),
  Tags: label ? [{ Key: "dozebox:label", Value: label }] : [],
});

describe("snapshots", () => {
  test("states map and the list is newest first, across pages", async () => {
    const { ops, stubs } = setup({
      ec2: (_c, _i, n) =>
        n === 0
          ? {
              Snapshots: [snap("s-old", "completed", 1000, "nightly"), snap("s-rec", "recoverable", 2000)],
              NextToken: "t",
            }
          : { Snapshots: [snap("s-err", "error", 3000), snap("s-pend", "pending", 500)] },
    });
    const out = await ops.snapshots("main");
    assert.deepEqual(
      out.map((s) => [s.id, s.state, s.startedAt, s.label]),
      [
        ["s-err", "error", 3000, null],
        ["s-rec", "pending", 2000, null],
        ["s-old", "completed", 1000, "nightly"],
        ["s-pend", "pending", 500, null],
      ],
    );
    const first = stubs.ec2.sent("DescribeSnapshotsCommand")[0];
    assert.deepEqual(first?.["Filters"], [{ Name: "tag:dozebox:box", Values: ["main"] }]);
    assert.deepEqual(first?.["OwnerIds"], ["self"]);
  });

  test("createSnapshot returns the existing id for a known token without creating", async () => {
    const { ops, stubs } = setup({
      ec2: (c) => (c === "DescribeSnapshotsCommand" ? { Snapshots: [{ SnapshotId: "s-1" }] } : undefined),
    });
    assert.equal(await ops.createSnapshot("vol-1", "x", "tok"), "s-1");
    assert.equal(stubs.ec2.sent("CreateSnapshotCommand").length, 0);
    assert.deepEqual(stubs.ec2.sent("DescribeSnapshotsCommand")[0]?.["Filters"], [
      { Name: "tag:dozebox:snapshot-token", Values: ["tok"] },
    ]);
  });

  test("createSnapshot tags the new snapshot from the volume", async () => {
    const { ops, stubs } = setup({
      ec2: (c) => {
        if (c === "DescribeSnapshotsCommand") return { Snapshots: [] };
        if (c === "DescribeVolumesCommand") {
          return {
            Volumes: [
              {
                VolumeId: "vol-1",
                Tags: [
                  { Key: "dozebox:box", Value: "main" },
                  { Key: "Name", Value: "main-data" },
                  { Key: "dozebox:test", Value: "dz-test-p3" },
                  { Key: "dozebox:active", Value: "true" },
                  { Key: "aws:cloudformation:stack-name", Value: "x" },
                ],
              },
            ],
          };
        }
        return { SnapshotId: "s-new" };
      },
    });
    assert.equal(await ops.createSnapshot("vol-1", "before upgrade", "tok"), "s-new");
    assert.deepEqual(stubs.ec2.sent("CreateSnapshotCommand")[0]?.["TagSpecifications"], [
      {
        ResourceType: "snapshot",
        Tags: [
          { Key: "Name", Value: "main-data" },
          { Key: "dozebox:test", Value: "dz-test-p3" },
          { Key: "dozebox:box", Value: "main" },
          { Key: "dozebox:label", Value: "before upgrade" },
          { Key: "dozebox:snapshot-token", Value: "tok" },
          { Key: "dozebox:snapshot", Value: "cli" },
        ],
      },
    ]);
  });
});

describe("volumes", () => {
  test("lists oldest first with the active and retired flags", async () => {
    const { ops } = setup({
      ec2: () => ({
        Volumes: [
          {
            VolumeId: "v-new",
            State: "available",
            AvailabilityZone: "a",
            CreateTime: new Date(2000),
            Tags: [{ Key: "dozebox:active", Value: "true" }],
          },
          {
            VolumeId: "v-old",
            State: "in-use",
            AvailabilityZone: "a",
            CreateTime: new Date(1000),
            Tags: [{ Key: "dozebox:retired", Value: "2026-01-01" }],
          },
        ],
      }),
    });
    assert.deepEqual(await ops.volumes("main"), [
      { id: "v-old", zone: "a", state: "in-use", active: false, retired: true },
      { id: "v-new", zone: "a", state: "available", active: true, retired: false },
    ]);
  });

  test("createVolume drops aws:*, snapshot, label, active and retired tags, keeps Name, sends the token", async () => {
    const { ops, stubs } = setup({
      ec2: (c) =>
        c === "DescribeSnapshotsCommand"
          ? {
              Snapshots: [
                {
                  SnapshotId: "s-1",
                  VolumeSize: 40,
                  Tags: [
                    { Key: "aws:cloudformation:stack-name", Value: "x" },
                    { Key: "Name", Value: "main-data" },
                    { Key: "dozebox:box", Value: "old" },
                    { Key: "dozebox:active", Value: "true" },
                    { Key: "dozebox:retired", Value: "d" },
                    { Key: "dozebox:label", Value: "l" },
                    { Key: "dozebox:snapshot", Value: "cli" },
                    { Key: "dozebox:snapshot-token", Value: "t" },
                    { Key: "team", Value: "infra" },
                  ],
                },
              ],
            }
          : { VolumeId: "v-new" },
    });
    const id = await ops.createVolume({ snapshotId: "s-1", zone: "eu-west-1a", boxId: "main", token: "tok" });
    assert.equal(id, "v-new");
    const sent = stubs.ec2.sent("CreateVolumeCommand")[0];
    assert.equal(sent?.["ClientToken"], "tok");
    assert.equal(sent?.["Encrypted"], true);
    assert.equal(sent?.["VolumeType"], "gp3");
    assert.equal(sent?.["AvailabilityZone"], "eu-west-1a");
    assert.equal(sent?.["Size"], 40);
    assert.equal(sent?.["Iops"], 3000);
    assert.equal(sent?.["Throughput"], 125);
    assert.deepEqual(sent?.["TagSpecifications"], [
      {
        ResourceType: "volume",
        Tags: [
          { Key: "Name", Value: "main-data" },
          { Key: "team", Value: "infra" },
          { Key: "dozebox:box", Value: "main" },
          { Key: "dozebox:active", Value: "false" },
        ],
      },
    ]);
  });

  test("retireVolume tags it inactive and retired and calls nothing else", async () => {
    const { ops, stubs } = setup({ ec2: () => ({}) });
    await ops.retireVolume("v-1");
    const tags = stubs.ec2.sent("CreateTagsCommand")[0]?.["Tags"] as Array<{ Key: string; Value: string }>;
    assert.deepEqual(tags[0], { Key: "dozebox:active", Value: "false" });
    assert.equal(tags[1]?.Key, "dozebox:retired");
    assert.match(tags[1]?.Value ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(stubs.ec2.calls.length, 1);
  });
});

describe("parameters", () => {
  test("secret names are validated and stored under the shared path", async () => {
    const { ops, stubs } = setup({ ssm: () => ({}) });
    await ops.putSecret("api_key-1.x", "v");
    assert.deepEqual(stubs.ssm.sent("PutParameterCommand"), [
      { Name: "/dozebox/shared/api_key-1.x", Value: "v", Type: "SecureString", Overwrite: true },
    ]);
    await rejectsCode(ops.putSecret("bad/name", "v"), "invalid_input");
    await rejectsCode(ops.deleteSecret(""), "invalid_input");
    assert.equal(stubs.ssm.calls.length, 1);
  });

  test("listSecrets pages, is not recursive, and returns short names", async () => {
    const { ops, stubs } = setup({
      ssm: (_c, _i, n) =>
        n === 0
          ? { Parameters: [{ Name: "/dozebox/shared/b" }], NextToken: "t" }
          : { Parameters: [{ Name: "/dozebox/shared/a" }] },
    });
    assert.deepEqual(await ops.listSecrets(), ["a", "b"]);
    assert.equal(stubs.ssm.sent("GetParametersByPathCommand")[0]?.["Recursive"], false);
  });

  test("getParameter maps ParameterNotFound to null and deleteParameter tolerates it", async () => {
    const { ops } = setup({
      ssm: () => {
        throw awsFault("ParameterNotFound", 400);
      },
    });
    assert.equal(await ops.getParameter("/x"), null);
    await ops.deleteParameter("/x");
  });

  test("putParameter picks the type", async () => {
    const { ops, stubs } = setup({ ssm: () => ({}) });
    await ops.putParameter("/a", "1", { secure: false });
    await ops.putParameter("/b", "2", { secure: true });
    assert.deepEqual(
      stubs.ssm.sent("PutParameterCommand").map((i) => i["Type"]),
      ["String", "SecureString"],
    );
  });
});

describe("account", () => {
  test("doctorFacts returns nulls, not throws, when every call is denied", async () => {
    const { ops } = setup({ all: denied });
    assert.deepEqual(await ops.doctorFacts(), {
      account: null,
      region: "eu-west-1",
      costTagActive: null,
      unreservedConcurrency: null,
      spotVcpuQuota: null,
      onDemandVcpuQuota: null,
    });
  });

  test("doctorFacts reads each fact", async () => {
    const { ops } = setup({
      all: (c, i) => {
        if (c === "GetCallerIdentityCommand") return { Account: "123456789012" };
        if (c === "ListCostAllocationTagsCommand") {
          return { CostAllocationTags: [{ TagKey: "dozebox:box", Status: "Active" }] };
        }
        if (c === "GetAccountSettingsCommand") return { AccountLimit: { UnreservedConcurrentExecutions: 900 } };
        if (c === "GetServiceQuotaCommand") return { Quota: { Value: i["QuotaCode"] === "L-34B43A08" ? 64 : 32 } };
        return undefined;
      },
    });
    assert.deepEqual(await ops.doctorFacts(), {
      account: "123456789012",
      region: "eu-west-1",
      costTagActive: true,
      unreservedConcurrency: 900,
      spotVcpuQuota: 64,
      onDemandVcpuQuota: 32,
    });
  });

  test("startAutomation wraps parameters in arrays and maps AccessDenied to aws_denied", async () => {
    const ok = setup({ ssm: () => ({ AutomationExecutionId: "ex-1" }) });
    assert.equal(await ok.ops.startAutomation("Doc", { A: "1" }), "ex-1");
    assert.deepEqual(ok.stubs.ssm.sent("StartAutomationExecutionCommand"), [
      { DocumentName: "Doc", Parameters: { A: ["1"] } },
    ]);
    await rejectsCode(setup({ ssm: denied }).ops.startAutomation("Doc", {}), "aws_denied");
  });

  test("testSpendUsd sums the month and is null when denied", async () => {
    const ok = setup({
      all: () => ({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: "1.5", Unit: "USD" } } }] }),
    });
    assert.equal(await ok.ops.testSpendUsd(), 1.5);
    assert.equal(await setup({ all: denied }).ops.testSpendUsd(), null);
  });

  test("emailSubscriptions keeps email only and flags pending", async () => {
    const { ops } = setup({
      all: () => ({
        Subscriptions: [
          { Protocol: "email", Endpoint: "a@x.io", SubscriptionArn: "PendingConfirmation" },
          { Protocol: "email", Endpoint: "b@x.io", SubscriptionArn: "arn:aws:sns:x" },
          { Protocol: "sms", Endpoint: "+1", SubscriptionArn: "arn:aws:sns:y" },
        ],
      }),
    });
    assert.deepEqual(await ops.emailSubscriptions("arn:topic"), [
      { endpoint: "a@x.io", pending: true },
      { endpoint: "b@x.io", pending: false },
    ]);
  });
});
