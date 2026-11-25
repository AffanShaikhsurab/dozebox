// L1: the stack context: `terraform output -json` of the stack dir, cached in `.dozebox/stack.json` (part 5 §5.2).
import { DozeboxCliError } from "./command.ts";
import type { CliFiles, Terraform, TerraformOutputs } from "./ports/terraform.ts";

export type UnfreezeRunbook = { readonly document: string; readonly parameters: Readonly<Record<string, string>> };

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
  /** Optional outputs (null when the module version does not have them). */
  readonly instanceRoleArn: string | null;
  readonly frontDoorDomain: string | null;
  readonly policySizes: Readonly<Record<string, number>> | null;
  readonly unfreeze: UnfreezeRunbook | null;
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

const CACHE_VERSION = 1;

export const stackFile = (stackDir: string): string => `${stackDir.replace(/[\\/]+$/, "")}/stack.json`;

/** Required outputs that are absent or not a non-empty string. */
export function missingOutputs(outputs: TerraformOutputs): ReadonlyArray<string> {
  return REQUIRED_OUTPUTS.filter((k) => {
    const v = outputs[k]?.value;
    return typeof v !== "string" || v === "";
  });
}

const str = (o: TerraformOutputs, k: string): string | null => {
  const v = o[k]?.value;
  return typeof v === "string" && v !== "" ? v : null;
};

function numberMap(v: unknown): Readonly<Record<string, number>> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === "number") out[k] = n;
  return out;
}

function runbook(v: unknown): UnfreezeRunbook | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as { readonly document?: unknown; readonly parameters?: unknown };
  if (typeof r.document !== "string" || typeof r.parameters !== "object" || r.parameters === null) return null;
  const parameters: Record<string, string> = {};
  for (const [k, p] of Object.entries(r.parameters)) if (typeof p === "string") parameters[k] = p;
  return { document: r.document, parameters };
}

/** Pure: outputs -> context, or `not-set-up` naming every missing output. */
export function stackFromOutputs(stackDir: string, o: TerraformOutputs): StackContext {
  const missing = missingOutputs(o);
  if (missing.length > 0) {
    throw new DozeboxCliError(
      "not-set-up",
      `The stack in ${stackDir} has no ${missing.join(", ")} output; run \`dozebox setup\` first.`,
    );
  }
  const req = (k: (typeof REQUIRED_OUTPUTS)[number]): string => str(o, k) ?? "";
  return {
    stackDir,
    boxId: req("box_id"),
    region: req("region"),
    controlUrl: req("control_url").replace(/\/+$/, ""),
    controlFunctionName: req("control_function_name"),
    ssmPrefix: req("ssm_prefix"),
    wakeTokenParameter: req("wake_token_parameter"),
    alertTopicArn: req("alert_topic_arn"),
    stateTableName: req("state_table_name"),
    dataVolumeId: str(o, "data_volume_id"),
    instanceRoleArn: str(o, "instance_role_arn"),
    frontDoorDomain: str(o, "front_door_domain_name"),
    policySizes: numberMap(o["iam_policy_sizes"]?.value),
    unfreeze: runbook(o["unfreeze_runbook"]?.value),
  };
}

function fromCache(stackDir: string, text: string | null): StackContext | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { readonly v?: unknown; readonly outputs?: unknown };
    if (parsed.v !== CACHE_VERSION || typeof parsed.outputs !== "object" || parsed.outputs === null) return null;
    return stackFromOutputs(stackDir, parsed.outputs as TerraformOutputs);
  } catch {
    return null;
  }
}

/** Non-sensitive outputs only: the cache file must never hold a secret. */
function cacheText(o: TerraformOutputs): string {
  const outputs: Record<string, { readonly value: unknown; readonly sensitive: false }> = {};
  for (const [k, v] of Object.entries(o)) if (!v.sensitive) outputs[k] = { value: v.value, sensitive: false };
  return `${JSON.stringify({ v: CACHE_VERSION, outputs }, null, 2)}\n`;
}

export async function readStack(
  deps: { readonly terraform: Terraform; readonly fs: CliFiles },
  stackDir: string,
  opts: { readonly refresh: boolean },
): Promise<StackContext> {
  if (!opts.refresh) {
    const cached = fromCache(stackDir, await deps.fs.readText(stackFile(stackDir)));
    if (cached !== null) return cached;
  }
  const outputs = await deps.terraform.output(stackDir);
  const stack = stackFromOutputs(stackDir, outputs);
  await deps.fs.writeText(stackFile(stackDir), cacheText(outputs));
  return stack;
}
