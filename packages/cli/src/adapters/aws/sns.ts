// Email subscriptions on the alert topic.
import { ListSubscriptionsByTopicCommand, SubscribeCommand, type SNSClient } from "@aws-sdk/client-sns";
import { fromAws } from "@dozebox/core/errors";
import type { AwsOps, EmailSubscription } from "../../ports/aws.ts";

export type SnsOps = Pick<AwsOps, "emailSubscriptions" | "subscribeEmail">;

export function makeSnsOps(sns: SNSClient): SnsOps {
  return {
    emailSubscriptions: async (topicArn) => {
      try {
        const found: EmailSubscription[] = [];
        let next: string | undefined;
        do {
          const out = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: next }));
          for (const s of out.Subscriptions ?? []) {
            if (s.Protocol === "email" && s.Endpoint !== undefined) {
              found.push({ endpoint: s.Endpoint, pending: s.SubscriptionArn === "PendingConfirmation" });
            }
          }
          next = out.NextToken;
        } while (next);
        return found;
      } catch (e) {
        throw fromAws(e);
      }
    },

    subscribeEmail: async (topicArn, email) => {
      try {
        await sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: "email", Endpoint: email }));
      } catch (e) {
        throw fromAws(e);
      }
    },
  };
}
