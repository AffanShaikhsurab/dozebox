// Every AWS port of the control function, built once per Lambda container from DOZEBOX_CONTROL. The SDK clients use
// the function's role credentials and region from the environment; Budgets is global and answers in us-east-1.
import { BudgetsClient } from "@aws-sdk/client-budgets";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SNSClient } from "@aws-sdk/client-sns";
import { SSMClient } from "@aws-sdk/client-ssm";
import type { ControlConfig } from "../../config.ts";
import type { Compute } from "../../ports/compute.ts";
import type { Notifier } from "../../ports/notify.ts";
import type { RecordStore } from "../../ports/records.ts";
import type { WakeTokenSource } from "../../ports/secrets.ts";
import type { Spend } from "../../ports/spend.ts";
import type { StateTable } from "../../ports/state.ts";
import type { Volumes } from "../../ports/volumes.ts";
import { asgClient, makeAwsGroup } from "./asg.ts";
import { makeAwsSpend } from "./budgets.ts";
import { makeAwsVolumes } from "./ebs.ts";
import { makeAwsStateTable } from "./dynamodb.ts";
import { ec2Client, makeAwsCompute, makeAwsMachines } from "./ec2.ts";
import { makeAwsWakeToken } from "./secrets.ts";
import { makeAwsNotifier } from "./sns.ts";
import { makeAwsRecordStore } from "./ssm.ts";

export type AwsPorts = {
  readonly compute: Compute;
  readonly records: RecordStore;
  readonly state: StateTable;
  readonly spend: Spend;
  readonly notifier: Notifier;
  readonly wakeToken: WakeTokenSource;
  readonly volumes: Volumes;
};

/** The account id from an ARN such as the alert topic's (`arn:aws:sns:<region>:<account>:<name>`). */
function accountOf(arn: string): string {
  const account = arn.split(":")[4] ?? "";
  if (!/^\d{12}$/.test(account)) throw new Error("alertTopicArn has no account id");
  return account;
}

export function makeAwsPorts(cfg: ControlConfig, now: () => number): AwsPorts {
  const region = cfg.box.region;
  const ec2 = ec2Client({ region });
  const ssm = new SSMClient({ region });
  return {
    compute: makeAwsCompute(
      makeAwsMachines({ ec2, prefix: cfg.box.prefix }),
      makeAwsGroup({ asg: asgClient({ region }), ec2 }),
    ),
    records: makeAwsRecordStore({ ssm, root: cfg.ssmPrefix }),
    state: makeAwsStateTable({ db: new DynamoDBClient({ region }), table: cfg.stateTable, now }),
    spend: makeAwsSpend({
      budgets: new BudgetsClient({ region: "us-east-1" }),
      accountId: accountOf(cfg.alertTopicArn),
      budgetName: cfg.caps.budgetName,
      now,
    }),
    notifier: makeAwsNotifier({ sns: new SNSClient({ region }), topicArn: cfg.alertTopicArn }),
    wakeToken: makeAwsWakeToken({ ssm, root: cfg.ssmPrefix }),
    volumes: makeAwsVolumes({ ec2, prefix: cfg.box.prefix }),
  };
}
