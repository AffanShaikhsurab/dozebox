// Every AWS adapter of the box, built from one region and one box root. The only module the composition root
// (deps.ts) imports from adapters/aws, so the SDK clients stay inside adapters (rule aws-sdk-only-in-adapters).
// Clients use the SDK's default credential chain (the instance profile on the box) and honour AWS_ENDPOINT_URL.
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { SNSClient } from "@aws-sdk/client-sns";
import type { LogTransport } from "../../ports/logs.ts";
import type { BoxNotifier } from "../../ports/notify.ts";
import type { ParameterReader } from "../../ports/params.ts";
import type { RecordWriter } from "../../ports/records.ts";
import type { SelfStop } from "../../ports/selfstop.ts";
import type { VolumeAttach } from "../../ports/volumes.ts";
import { makeAwsVolumeAttach } from "./ebs.ts";
import { asgClient, ec2Client, makeAwsSelfStop } from "./ec2.ts";
import { makeAwsLogTransport } from "./logs.ts";
import { makeAwsBoxNotifier } from "./sns.ts";
import { makeAwsParameterReader, makeAwsRecordWriter, ssmClient } from "./ssm.ts";

export type AwsPorts = {
  readonly params: ParameterReader;
  readonly recordWriter: RecordWriter;
  readonly selfStop: SelfStop;
  readonly volumes: VolumeAttach;
  readonly logs: LogTransport;
  /** The topic comes from the box config, so the notifier is made once the config is known. */
  readonly notifierFor: (topicArn: string) => BoxNotifier;
};

export type AwsPortsOptions = {
  readonly region: string;
  /** The box root, such as `/dozebox/box-1/`. */
  readonly root: string;
  readonly prefix: string;
};

export function makeAwsPorts(opts: AwsPortsOptions): AwsPorts {
  const cfg = { region: opts.region };
  const ssm = ssmClient(cfg);
  const ec2 = ec2Client(cfg);
  const sns = new SNSClient(cfg);
  return {
    params: makeAwsParameterReader({ ssm, root: opts.root }),
    recordWriter: makeAwsRecordWriter({ ssm, root: opts.root }),
    selfStop: makeAwsSelfStop({ ec2, asg: asgClient(cfg) }),
    volumes: makeAwsVolumeAttach({ ec2, prefix: opts.prefix }),
    logs: makeAwsLogTransport({ logs: new CloudWatchLogsClient(cfg) }),
    notifierFor: (topicArn) => makeAwsBoxNotifier({ sns, topicArn }),
  };
}
