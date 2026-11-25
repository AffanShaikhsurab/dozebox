// AWS adapter for the operator's alert topic: one SNS Publish per notice. The subject and body are shaped by core's
// shapeSnsNotice (ASCII subject under 100 characters, body within 256 KiB with its attributes), so a title with an
// emoji or a long log excerpt still pages. Attributes go as `String` message attributes for subscription filters.
// Publish takes no client token; the alert outbox (phase 2) carries delivery and retry.
import { PublishCommand, type MessageAttributeValue, type SNSClient } from "@aws-sdk/client-sns";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import { shapeSnsNotice } from "@dozebox/core/notice";
import type { Notifier } from "../../ports/notify.ts";

export type AwsNotifierDeps = { readonly sns: SNSClient; readonly topicArn: string };

export function makeAwsNotifier(deps: AwsNotifierDeps): Notifier {
  return {
    publish: async (notice) => {
      const shaped = shapeSnsNotice(notice);
      const attributes: Record<string, MessageAttributeValue> = {};
      for (const [name, value] of Object.entries(shaped.attributes)) {
        attributes[name] = { DataType: "String", StringValue: value };
      }
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
