// Wire: the log transport against the emulator (`pnpm test:wire`; skips when the emulator is not running).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CloudWatchLogsClient, CreateLogGroupCommand, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { fresh, rejectsWith } from "@dozebox/testkit/contracts";
import { eventually, faultInjector, resolveWire } from "@dozebox/testkit/wire";
import { makeAwsLogTransport } from "../../src/adapters/aws/logs.ts";

const target = await resolveWire();

async function make() {
  const logs = new CloudWatchLogsClient(target.config);
  const group = `/dozebox/${fresh("box")}/box`;
  await logs.send(new CreateLogGroupCommand({ logGroupName: group }));
  return { logs, group, inject: faultInjector(logs), transport: makeAwsLogTransport({ logs }) };
}

test("wire logs: a new stream is created and events land in time order", { skip: target.skip }, async () => {
  const { logs, group, transport } = await make();
  const t = Date.now() - 60_000;
  const sent = await transport.send(group, "i-wire", [
    { at: t + 2, message: "second" },
    { at: t + 1, message: "first" },
  ]);
  assert.equal(sent, 2);
  assert.equal(await transport.send(group, "i-wire", [{ at: t + 3, message: "third" }]), 1);
  await eventually(async () => {
    const out = await logs.send(
      new GetLogEventsCommand({ logGroupName: group, logStreamName: "i-wire", startFromHead: true }),
    );
    const messages = (out.events ?? []).map((e) => e.message);
    return JSON.stringify(messages) === JSON.stringify(["first", "second", "third"]);
  }, "three events in order");
});

test(
  "wire logs: a missing group is aws_not_found; an injected throttle is aws_throttled",
  { skip: target.skip },
  async () => {
    const { group, inject, transport } = await make();
    await rejectsWith(
      transport.send(`${group}-missing`, "s", [{ at: Date.now(), message: "x" }]),
      "aws_not_found",
      false,
    );
    inject("PutLogEventsCommand", "ThrottlingException", 400);
    await rejectsWith(transport.send(group, "s", [{ at: Date.now(), message: "x" }]), "aws_throttled", true);
  },
);
