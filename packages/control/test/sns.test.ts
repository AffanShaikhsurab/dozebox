import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SNSClient } from "@aws-sdk/client-sns";
import { rejectsWith } from "@dozebox/testkit/contracts";
import { offlineConfig, stubHandlers } from "@dozebox/testkit/wire";
import { makeAwsNotifier } from "../src/adapters/aws/sns.ts";

const TOPIC = "arn:aws:sns:us-east-1:000000000000:dozebox-box-1-alerts";

function setup() {
  const sns = new SNSClient(offlineConfig);
  const stub = stubHandlers(sns);
  stub.on("PublishCommand", () => ({ MessageId: "m-1" }));
  return { stub, notifier: makeAwsNotifier({ sns, topicArn: TOPIC }) };
}

test("publish sends the shaped subject, body and String attributes, and returns the message id", async () => {
  const { stub, notifier } = setup();
  const id = await notifier.publish({
    subject: "Dozebox: box-1 🚨\nneeds you",
    body: "parked",
    attributes: { severity: "page", key: "cap" },
  });
  assert.equal(id, "m-1");
  assert.deepEqual(stub.inputs("PublishCommand"), [
    {
      TopicArn: TOPIC,
      Message: "parked",
      Subject: "Dozebox: box-1 needs you",
      MessageAttributes: {
        severity: { DataType: "String", StringValue: "page" },
        key: { DataType: "String", StringValue: "cap" },
      },
    },
  ]);
});

test("no attributes and an empty subject: neither is sent", async () => {
  const { stub, notifier } = setup();
  await notifier.publish({ subject: "✅", body: "b" });
  assert.deepEqual(stub.inputs("PublishCommand"), [{ TopicArn: TOPIC, Message: "b" }]);
});

test("a bad attribute is refused before the call", async () => {
  const { stub, notifier } = setup();
  await rejectsWith(
    notifier.publish({ subject: "s", body: "b", attributes: { "AWS.x": "1" } }),
    "invalid_input",
    false,
  );
  assert.equal(stub.calls.length, 0);
});

test("errors are mapped; a missing message id is internal", async () => {
  const { stub, notifier } = setup();
  stub.fail("PublishCommand", "AuthorizationError", 403);
  await rejectsWith(notifier.publish({ subject: "s", body: "b" }), "aws_denied", false);
  stub.fail("PublishCommand", "Throttled", 429);
  await rejectsWith(notifier.publish({ subject: "s", body: "b" }), "aws_throttled", true);
  stub.fail("PublishCommand", "NotFound", 404);
  await rejectsWith(notifier.publish({ subject: "s", body: "b" }), "aws_not_found", false);
  stub.on("PublishCommand", () => ({}));
  await rejectsWith(notifier.publish({ subject: "s", body: "b" }), "internal", false);
});
