// Wire: the box notifier against the emulator (`pnpm test:wire`; skips when the emulator is not running).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CreateTopicCommand, SNSClient } from "@aws-sdk/client-sns";
import { fresh, rejectsWith } from "@dozebox/testkit/contracts";
import { faultInjector, resolveWire } from "@dozebox/testkit/wire";
import { makeAwsBoxNotifier } from "../../src/adapters/aws/sns.ts";

const target = await resolveWire();

test(
  "wire sns (box): publish returns a message id; a missing topic is aws_not_found",
  { skip: target.skip },
  async () => {
    const sns = new SNSClient(target.config);
    const topic = await sns.send(new CreateTopicCommand({ Name: fresh("dozebox-alerts") }));
    assert.ok(topic.TopicArn);
    const notifier = makeAwsBoxNotifier({ sns, topicArn: topic.TopicArn });
    const id = await notifier.publish({
      subject: "Attention ✅\nneeded",
      body: "b",
      attributes: { severity: "notify" },
    });
    assert.ok(id.length > 0);
    const missing = makeAwsBoxNotifier({ sns, topicArn: "arn:aws:sns:us-east-1:000000000000:dozebox-no-such-topic" });
    await rejectsWith(missing.publish({ subject: "s", body: "b" }), "aws_not_found", false);
  },
);

test("wire sns (box): an injected 5xx is aws_unavailable", { skip: target.skip }, async () => {
  const sns = new SNSClient(target.config);
  const inject = faultInjector(sns);
  inject("PublishCommand", "InternalError", 500);
  const notifier = makeAwsBoxNotifier({ sns, topicArn: "arn:aws:sns:us-east-1:000000000000:x" });
  await rejectsWith(notifier.publish({ subject: "s", body: "b" }), "aws_unavailable", true);
});
