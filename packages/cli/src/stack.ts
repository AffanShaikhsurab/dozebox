// L1: the stack context: `terraform output -json` of the stack dir, cached in `.dozebox/stack.json` (part 5 §5.2).
import type { CliFiles, Terraform } from "./ports/terraform.ts";

export type StackContext = {
  readonly stackDir: string;
  readonly boxId: string;
  readonly region: string;
  readonly controlUrl: string;
  readonly controlFunctionName: string;
  readonly ssmPrefix: string;
  readonly wakeTokenParameter: string;
  readonly alertTopicArn: string;
  readonly stateTableName: string;
  readonly dataVolumeId: string | null;
};

/** The outputs every command needs; a missing one is DozeboxCliError `not-set-up` naming it (exit 3). */
export const REQUIRED_OUTPUTS = [
  "box_id",
  "region",
  "control_url",
  "control_function_name",
  "ssm_prefix",
  "wake_token_parameter",
  "alert_topic_arn",
  "state_table_name",
] as const;

export function readStack(
  _deps: { readonly terraform: Terraform; readonly fs: CliFiles },
  _stackDir: string,
  _opts: { readonly refresh: boolean },
): Promise<StackContext> {
  throw new Error("not implemented: L1 readStack");
}
