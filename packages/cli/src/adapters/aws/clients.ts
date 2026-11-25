// The SDK clients the CLI's AWS adapter uses. Tests pass stubbed ones; the defaults are built from the region.
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { EC2Client } from "@aws-sdk/client-ec2";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { SNSClient } from "@aws-sdk/client-sns";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";

export type AwsClients = {
  readonly ec2: EC2Client;
  readonly ssm: SSMClient;
  readonly sts: STSClient;
  readonly lambda: LambdaClient;
  readonly ce: CostExplorerClient;
  readonly quotas: ServiceQuotasClient;
  readonly sns: SNSClient;
};

/** Cost Explorer has one endpoint, in us-east-1, whatever the stack's region. */
export function defaultClients(region: string, given: Partial<AwsClients> = {}): AwsClients {
  return {
    ec2: given.ec2 ?? new EC2Client({ region }),
    ssm: given.ssm ?? new SSMClient({ region }),
    sts: given.sts ?? new STSClient({ region }),
    lambda: given.lambda ?? new LambdaClient({ region }),
    ce: given.ce ?? new CostExplorerClient({ region: "us-east-1" }),
    quotas: given.quotas ?? new ServiceQuotasClient({ region }),
    sns: given.sns ?? new SNSClient({ region }),
  };
}
