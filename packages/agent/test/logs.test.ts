// The CloudWatch Logs transport on a stubbed SDK client: ordering, batch limits, stream creation, rejections.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { rejectsWith } from "@dozebox/testkit/contracts";
import { offlineConfig, sdkError, stubHandlers } from "@dozebox/testkit/wire";
import { acceptedCount, makeAwsLogTransport } from "../src/adapters/aws/logs.ts";

type Sent = { readonly timestamp: number; readonly message: string };
const GROUP = "/dozebox/box-1/box";

function setup(opts: { readonly streams?: string[] } = {}) {
  const logs = new CloudWatchLogsClient(offlineConfig);
  const stub = stubHandlers(logs);
  const streams = new Map<string, Sent[]>((opts.streams ?? []).map((s) => [s, []]));
  stub.on("PutLogEventsCommand", (input) => {
    const list = streams.get(String(input["logStreamName"]));
    if (!list) throw sdkError("ResourceNotFoundException", 400, "The specified log stream does not exist.");
    const events = input["logEvents"] as Sent[];
    for (let i = 1; i < events.length; i++) {
      assert.ok((events[i - 1]?.timestamp ?? 0) <= (events[i]?.timestamp ?? 0), "events in time order");
    }
    list.push(...events);
    return {};
  });
  stub.on("CreateLogStreamCommand", (input) => {
    const name = String(input["logStreamName"]);
    if (streams.has(name)) throw sdkError("ResourceAlreadyExistsException", 400);
    streams.set(name, []);
    return {};
  });
  return { stub, streams, transport: makeAwsLogTransport({ logs }) };
}

const batchesSent = (stub: ReturnType<typeof setup>["stub"]) =>
  stub.inputs("PutLogEventsCommand").map((i) => i["logEvents"] as Sent[]);

test("events go in time order to the stream; no sequence token is sent", async () => {
  const { stub, streams, transport } = setup({ streams: ["i-1"] });
  const n = await transport.send(GROUP, "i-1", [
    { at: 3, message: "c" },
    { at: 1, message: "a" },
    { at: 2, message: "b" },
  ]);
  assert.equal(n, 3);
  assert.deepEqual(
    streams.get("i-1")?.map((e) => e.message),
    ["a", "b", "c"],
  );
  assert.deepEqual(Object.keys(stub.inputs("PutLogEventsCommand")[0] ?? {}).toSorted(), [
    "logEvents",
    "logGroupName",
    "logStreamName",
  ]);
});

test("no events -> no call", async () => {
  const { stub, transport } = setup({ streams: ["i-1"] });
  assert.equal(await transport.send(GROUP, "i-1", []), 0);
  assert.equal(stub.calls.length, 0);
});

test("a missing stream is created once and the batch sent again", async () => {
  const { stub, streams, transport } = setup();
  assert.equal(await transport.send(GROUP, "i-2", [{ at: 1, message: "x" }]), 1);
  assert.deepEqual(
    stub.calls.map((c) => c.command),
    ["PutLogEventsCommand", "CreateLogStreamCommand", "PutLogEventsCommand"],
  );
  assert.deepEqual(stub.inputs("CreateLogStreamCommand"), [{ logGroupName: GROUP, logStreamName: "i-2" }]);
  assert.equal(streams.get("i-2")?.length, 1);
});

test("a stream another writer created in between is fine", async () => {
  const { stub, streams, transport } = setup({ streams: ["i-3"] });
  stub.fail("PutLogEventsCommand", "ResourceNotFoundException", 400);
  assert.equal(await transport.send(GROUP, "i-3", [{ at: 1, message: "x" }]), 1);
  assert.equal(streams.get("i-3")?.length, 1);
});

test("a missing group is aws_not_found; other errors are mapped without a stream create", async () => {
  const { stub, transport } = setup();
  stub.fail("PutLogEventsCommand", "ResourceNotFoundException", 400);
  stub.fail("CreateLogStreamCommand", "ResourceNotFoundException", 400, "The specified log group does not exist.");
  await rejectsWith(transport.send(GROUP, "i-4", [{ at: 1, message: "x" }]), "aws_not_found", false);
  stub.fail("PutLogEventsCommand", "ThrottlingException", 400);
  await rejectsWith(transport.send(GROUP, "i-4", [{ at: 1, message: "x" }]), "aws_throttled", true);
  assert.equal(stub.inputs("CreateLogStreamCommand").length, 1);
  stub.fail("PutLogEventsCommand", "ResourceNotFoundException", 400);
  stub.fail("CreateLogStreamCommand", "AccessDeniedException", 400);
  await rejectsWith(transport.send(GROUP, "i-5", [{ at: 1, message: "x" }]), "aws_denied", false);
  stub.fail("PutLogEventsCommand", "ResourceNotFoundException", 400);
  stub.fail("PutLogEventsCommand", "ServiceUnavailableException", 503);
  await rejectsWith(transport.send(GROUP, "i-6", [{ at: 1, message: "x" }]), "aws_unavailable", true);
});

test("batches stay under 10,000 events, 1 MiB with 26 bytes per event, and 24 hours", async () => {
  const { stub, transport } = setup({ streams: ["s"] });
  const many = Array.from({ length: 10_001 }, (_, i) => ({ at: i, message: "m" }));
  assert.equal(await transport.send(GROUP, "s", many), 10_001);
  assert.deepEqual(
    batchesSent(stub).map((b) => b.length),
    [10_000, 1],
  );

  const big = setup({ streams: ["s"] });
  const kb100 = "x".repeat(100_000 - 26);
  assert.equal(
    await big.transport.send(
      GROUP,
      "s",
      Array.from({ length: 11 }, (_, i) => ({ at: i, message: kb100 })),
    ),
    11,
  );
  assert.deepEqual(
    batchesSent(big.stub).map((b) => b.length),
    [10, 1],
  );

  const day = setup({ streams: ["s"] });
  const h = 3_600_000;
  await day.transport.send(
    GROUP,
    "s",
    [0, h, 24 * h - 1, 24 * h, 30 * h].map((at) => ({ at, message: "m" })),
  );
  assert.deepEqual(
    batchesSent(day.stub).map((b) => b.map((e) => e.timestamp)),
    [
      [0, h, 24 * h - 1],
      [24 * h, 30 * h],
    ],
  );
});

test("an oversize message is cut at a character boundary; an empty one is sent as a space", async () => {
  const { stub, transport } = setup({ streams: ["s"] });
  await transport.send(GROUP, "s", [
    { at: 1, message: "é".repeat(200_000) },
    { at: 2, message: "" },
  ]);
  const [batch] = batchesSent(stub);
  const first = batch?.[0]?.message ?? "";
  assert.ok(new TextEncoder().encode(first).length <= 262_144 - 26);
  assert.ok(first.endsWith(" [truncated]"));
  assert.ok(!first.includes("\uFFFD"));
  assert.equal(batch?.[1]?.message, " ");
});

test("events the service rejects are counted out", async () => {
  const { stub, transport } = setup({ streams: ["s"] });
  stub.on("PutLogEventsCommand", () => ({
    rejectedLogEventsInfo: { tooOldLogEventEndIndex: 1, tooNewLogEventStartIndex: 4 },
  }));
  assert.equal(
    await transport.send(
      GROUP,
      "s",
      Array.from({ length: 6 }, (_, i) => ({ at: i, message: "m" })),
    ),
    2,
  );
  assert.equal(acceptedCount(5, undefined), 5);
  assert.equal(acceptedCount(5, {}), 5);
  assert.equal(acceptedCount(5, { expiredLogEventEndIndex: 2, tooOldLogEventEndIndex: 0 }), 2);
  assert.equal(acceptedCount(5, { tooNewLogEventStartIndex: 0 }), 0);
  assert.equal(acceptedCount(5, { expiredLogEventEndIndex: 4 }), 0);
});
