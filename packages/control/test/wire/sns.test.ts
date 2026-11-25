// Wire: the alert notifier against the emulator (`pnpm test:wire`; skips when the emulator is not running).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CreateTopicCommand, SNSClient } from "@aws-sdk/client-sns";
import { fresh, rejectsWith } from "@dozebox/testkit/contracts";
import { faultInjector, resolveWire } from "@dozebox/testkit/wire";
import { makeAwsNotifier } from "../../src/adapters/aws/sns.ts";

const target = await resolveWire();

async function make() {
  const sns = new SNSClient(target.config);
  const inject = faultInjector(sns);
  const topic = await sns.send(new CreateTopicCommand({ Name: fresh("dozebox-alerts") }));
  if (!topic.TopicArn) throw new Error("the emulator returned no topic ARN");
  return { sns, inject, notifier: makeAwsNotifier({ sns, topicArn: topic.TopicArn }) };
}

test(
  "wire sns: a non-ASCII, multi-line, long subject and a big body still publish",
  { skip: target.skip },
  async () => {
    const { notifier } = await make();
    const id = await notifier.publish({
      subject: "Run 42 ✅ needs you 🚨\n".repeat(10),
      body: "é".repeat(140_000),
      attributes: { severity: "page", key: "wire" },
    });
    assert.ok(id.length > 0);
  },
);

test("wire sns: a missing topic is aws_not_found", { skip: target.skip }, async () => {
  const { sns } = await make();
  const missing = makeAwsNotifier({ sns, topicArn: "arn:aws:sns:us-east-1:000000000000:dozebox-no-such-topic" });
  await rejectsWith(missing.publish({ subject: "s", body: "b" }), "aws_not_found", false);
});

test(
  "wire sns: throttling (injected in the client, unit-only on the emulator) is aws_throttled",
  { skip: target.skip },
  async () => {
    const { inject, notifier } = await make();
    inject("PublishCommand", "Throttled", 429);
    await rejectsWith(notifier.publish({ subject: "s", body: "b" }), "aws_throttled", true);
    assert.ok(await notifier.publish({ subject: "s", body: "b" }));
  },
);
