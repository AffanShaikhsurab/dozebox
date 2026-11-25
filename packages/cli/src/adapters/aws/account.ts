// Account-level calls: identity, doctor facts, cost allocation, Automation, spend.
import {
  GetCostAndUsageCommand,
  ListCostAllocationTagsCommand,
  UpdateCostAllocationTagsStatusCommand,
  type CostExplorerClient,
} from "@aws-sdk/client-cost-explorer";
import { GetAccountSettingsCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { GetServiceQuotaCommand, type ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { StartAutomationExecutionCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, type STSClient } from "@aws-sdk/client-sts";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import type { AwsOps } from "../../ports/aws.ts";

export type AccountOps = Pick<
  AwsOps,
  "doctorFacts" | "activateCostTag" | "callerArn" | "startAutomation" | "testSpendUsd"
>;

export type AccountDeps = {
  readonly region: string;
  readonly tagPrefix: string;
  readonly sts: STSClient;
  readonly lambda: LambdaClient;
  readonly ce: CostExplorerClient;
  readonly quotas: ServiceQuotasClient;
  readonly ssm: SSMClient;
};

const wrap = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (e) {
    throw fromAws(e);
  }
};

/** The value, or null when the call fails for any reason (a doctor fact never throws). */
const orNull = async <T>(run: () => Promise<T | null | undefined>): Promise<T | null> => {
  try {
    return (await run()) ?? null;
  } catch {
    return null;
  }
};

const day = (d: Date): string => d.toISOString().slice(0, 10);

export function makeAccountOps(deps: AccountDeps): AccountOps {
  const { sts, lambda, ce, quotas, ssm } = deps;
  const costTag = `${deps.tagPrefix}:box`;
  const testTag = `${deps.tagPrefix}:test`;

  const quota = (code: string) =>
    orNull(
      async () => (await quotas.send(new GetServiceQuotaCommand({ ServiceCode: "ec2", QuotaCode: code }))).Quota?.Value,
    );

  const callerArn = () =>
    wrap(async () => {
      const arn = (await sts.send(new GetCallerIdentityCommand({}))).Arn;
      if (!arn) throw new RunnerError("internal", false, "GetCallerIdentity returned no ARN");
      return arn;
    });

  return {
    callerArn,

    doctorFacts: async () => {
      const [account, costTagActive, unreservedConcurrency, spotVcpuQuota, onDemandVcpuQuota] = await Promise.all([
        orNull(async () => (await sts.send(new GetCallerIdentityCommand({}))).Account),
        orNull(async () => {
          const out = await ce.send(new ListCostAllocationTagsCommand({ TagKeys: [costTag] }));
          return out.CostAllocationTags?.some((t) => t.TagKey === costTag && t.Status === "Active") ?? false;
        }),
        orNull(
          async () =>
            (await lambda.send(new GetAccountSettingsCommand({}))).AccountLimit?.UnreservedConcurrentExecutions,
        ),
        quota("L-34B43A08"),
        quota("L-1216C47A"),
      ]);
      return { account, region: deps.region, costTagActive, unreservedConcurrency, spotVcpuQuota, onDemandVcpuQuota };
    },

    activateCostTag: (key) =>
      wrap(async () => {
        await ce.send(
          new UpdateCostAllocationTagsStatusCommand({ CostAllocationTagsStatus: [{ TagKey: key, Status: "Active" }] }),
        );
      }),

    startAutomation: (document, params) =>
      wrap(async () => {
        const Parameters = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, [v]]));
        const out = await ssm.send(new StartAutomationExecutionCommand({ DocumentName: document, Parameters }));
        if (!out.AutomationExecutionId) {
          throw new RunnerError("internal", false, "StartAutomationExecution returned no execution id");
        }
        return out.AutomationExecutionId;
      }),

    testSpendUsd: async () => {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = new Date(now.getTime() + 86_400_000);
      try {
        const out = await ce.send(
          new GetCostAndUsageCommand({
            TimePeriod: { Start: day(start), End: day(end) },
            Granularity: "MONTHLY",
            Metrics: ["UnblendedCost"],
            Filter: { Not: { Tags: { Key: testTag, MatchOptions: ["ABSENT"] } } },
          }),
        );
        return (out.ResultsByTime ?? []).reduce((sum, r) => sum + Number(r.Total?.["UnblendedCost"]?.Amount ?? 0), 0);
      } catch (e) {
        const err = fromAws(e);
        if (err.code === "aws_denied") return null;
        throw err;
      }
    },
  };
}
