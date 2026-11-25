import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SNSClient } from "@aws-sdk/client-sns";
import { rejectsWith } from "@dozebox/testkit/contracts";
import { offlineConfig, stubSdk } from "@dozebox/testkit/wire";
import { makeAwsBoxNotifier } from "../src/adapters/aws/sns.ts";

const TOPIC = "arn:aws:sns:us-east-1:000000000000:dozebox-box-1-alerts";

function setup() {
  const sns = new SNSClient(offlineConfig);
  const stub = stubSdk(sns);
  stub.on("PublishCommand", () => ({ MessageId: "m-9" }));
  return { stub, notifier: makeAwsBoxNotifier({ sns, topicArn: TOPIC }) };
}

test("publish sends the shaped notice with String attributes and returns the message id", async () => {
  const { stub, notifier } = setup();
  assert.equal(
    await notifier.publish({ subject: "Run 42 ✅ needs you", body: "b", attributes: { severity: "notify" } }),
    "m-9",
  );
  assert.deepEqual(stub.inputs("PublishCommand"), [
    {
      TopicArn: TOPIC,
      Message: "b",
      Subject: "Run 42 needs you",
      MessageAttributes: { severity: { DataType: "String", StringValue: "notify" } },
    },
  ]);
  await notifier.publish({ subject: "", body: "x" });
  assert.deepEqual(stub.inputs("PublishCommand")[1], { TopicArn: TOPIC, Message: "x" });
});

test("errors are mapped; a bad attribute never reaches the call; no message id is internal", async () => {
  const { stub, notifier } = setup();
  stub.fail("PublishCommand", "InternalError", 500);
  await rejectsWith(notifier.publish({ subject: "s", body: "b" }), "aws_unavailable", true);
  await rejectsWith(notifier.publish({ subject: "s", body: "b", attributes: { "a..b": "1" } }), "invalid_input", false);
  assert.equal(stub.calls.length, 1);
  stub.on("PublishCommand", () => ({ MessageId: "" }));
  await rejectsWith(notifier.publish({ subject: "s", body: "b" }), "internal", false);
});
