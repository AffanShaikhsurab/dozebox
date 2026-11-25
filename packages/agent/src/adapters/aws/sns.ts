// AWS adapter for attention and runner alerts from the box: one SNS Publish to the operator's topic (the box role may
// only publish to it). Shaped by core's shapeSnsNotice, like the control function's notifier: an ASCII subject under
// 100 characters, the body within 256 KiB with its attributes. A failed publish throws; the caller keeps the notice
// in rec/liveness `undelivered`.
import { PublishCommand, type MessageAttributeValue, type SNSClient } from "@aws-sdk/client-sns";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import { shapeSnsNotice } from "@dozebox/core/notice";
import type { BoxNotifier } from "../../ports/notify.ts";

export type AwsBoxNotifierDeps = { readonly sns: SNSClient; readonly topicArn: string };

export function makeAwsBoxNotifier(deps: AwsBoxNotifierDeps): BoxNotifier {
  return {
    publish: async (notice) => {
      const shaped = shapeSnsNotice(notice);
      const attributes = Object.fromEntries(
        Object.entries(shaped.attributes).map(([k, v]): [string, MessageAttributeValue] => [
          k,
          { DataType: "String", StringValue: v },
        ]),
      );
      let id: string | undefined;
      try {
        const out = await deps.sns.send(
          new PublishCommand({
            TopicArn: deps.topicArn,
            Message: shaped.message,
            ...(shaped.subject === undefined ? {} : { Subject: shaped.subject }),
            ...(Object.keys(attributes).length === 0 ? {} : { MessageAttributes: attributes }),
          }),
        );
        id = out.MessageId;
      } catch (e) {
        throw fromAws(e);
      }
      if (!id) throw new RunnerError("internal", false, "SNS Publish returned no message id");
      return id;
    },
  };
}
