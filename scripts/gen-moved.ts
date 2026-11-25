// T6: read `terraform state list` of the old root and write `moved` and `removed` blocks for the module.
// Usage: terraform state list | node scripts/gen-moved.ts [--module <name>] > moved.tf
import { readFileSync } from "node:fs";

export type MovedPlan = {
  readonly moved: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly removed: ReadonlyArray<string>;
  /** Addresses with no rule: the run fails while any are left. */
  readonly unknown: ReadonlyArray<string>;
};

export type Rule = {
  /** `type.name` of the resource in the old root. */
  readonly from: string;
  /** `type.name` (optionally with an instance key) in the module, or null when the module has no counterpart. */
  readonly to: string | null;
  /** keep: the old instance key moves as is. add0: old was a single resource, new is counted. strip: the reverse. */
  readonly index?: "keep" | "add0" | "strip" | undefined;
};

const same = (names: ReadonlyArray<string>, index?: Rule["index"]): Rule[] =>
  names.map((from) => ({ from, to: from, index }));
const EVENT_RULES = [
  ["spot_warning", "spot-warning"],
  ["instance_stopped", "ec2-state"],
] as const;

const gone = (names: ReadonlyArray<string>): Rule[] => names.map((from) => ({ from, to: null }));

// Derived from legacy/terraform/runner/*.tf against terraform/*.tf. A same-type counterpart moves even when its AWS
// name changes: the plan then shows the replacement. Everything without a counterpart is forgotten, never destroyed.
export const LEGACY_RULES: ReadonlyArray<Rule> = [
  ...same(
    [
      "aws_vpc.box",
      "aws_internet_gateway.box",
      "aws_subnet.box",
      "aws_route_table.box",
      "aws_route_table_association.box",
      "aws_ebs_volume.data",
      "aws_cloudwatch_event_rule.kill",
      "aws_cloudwatch_event_target.kill",
    ],
    "add0",
  ),
  ...same(
    [
      "aws_security_group.box",
      "aws_lambda_function.control",
      "aws_lambda_function_url.control",
      "aws_lambda_function_event_invoke_config.control",
      "aws_cloudwatch_log_group.box",
      "aws_cloudwatch_log_group.control",
      "aws_scheduler_schedule.reconcile",
      "aws_iam_role.control",
      "aws_iam_role.scheduler",
      "aws_iam_role.kill_events",
      "aws_iam_instance_profile.box",
      "aws_ssm_document.kill",
      "aws_dlm_lifecycle_policy.snapshots",
      "aws_rbin_rule.snapshots",
    ],
    "keep",
  ),
  ...same(
    ["aws_sns_topic.alerts", "aws_sns_topic_policy.alerts", "aws_cloudwatch_metric_alarm.control_quiet"],
    "strip",
  ),
  { from: "aws_iam_role.instance", to: "aws_iam_role.box" },
  { from: "aws_lambda_permission.url_public", to: "aws_lambda_permission.control_url_public", index: "add0" },
  { from: "aws_lambda_permission.invoke_via_url", to: "aws_lambda_permission.control_url_invoke", index: "add0" },
  { from: "aws_sns_topic_subscription.alerts_email", to: "aws_sns_topic_subscription.email" },
  { from: "aws_iam_role.kill_runbook", to: "aws_iam_role.kill" },
  { from: "aws_iam_role.dlm", to: "aws_iam_role.snapshots" },
  { from: "aws_budgets_budget.monthly", to: "aws_budgets_budget.box" },
  { from: "aws_sqs_queue.control_failed", to: "aws_sqs_queue.control_dlq" },
  { from: "aws_instance.box", to: "aws_instance.persistent" },
  { from: "aws_autoscaling_group.box", to: "aws_autoscaling_group.spot", index: "add0" },
  { from: "aws_autoscaling_group.od", to: "aws_autoscaling_group.fallback", index: "add0" },
  { from: "aws_launch_template.box", to: 'aws_launch_template.box["persistent"]' },
  { from: "aws_launch_template.od", to: 'aws_launch_template.box["group"]' },
  ...EVENT_RULES.flatMap(([old, key]) =>
    ["aws_cloudwatch_event_rule", "aws_cloudwatch_event_target"].map((type) => ({
      from: `${type}.${old}`,
      to: `${type}.control["${key}"]`,
      index: "strip" as const,
    })),
  ),
  { from: "aws_lambda_permission.spot_warning", to: "aws_lambda_permission.control_events_spot", index: "strip" },
  {
    from: "aws_lambda_permission.instance_stopped",
    to: "aws_lambda_permission.control_events_state",
    index: "strip",
  },
  ...gone([
    // inline role policies: the module attaches managed policies instead
    "aws_iam_role_policy.caps",
    "aws_iam_role_policy.control",
    "aws_iam_role_policy.control_alert_path",
    "aws_iam_role_policy.control_alert_router",
    "aws_iam_role_policy.dlm",
    "aws_iam_role_policy.fis",
    "aws_iam_role_policy.freeze",
    "aws_iam_role_policy.instance",
    "aws_iam_role_policy.instance_od_group",
    "aws_iam_role_policy.instance_ssm_session",
    "aws_iam_role_policy.kill_events",
    "aws_iam_role_policy.kill_runbook",
    "aws_iam_role_policy.scheduler",
    "aws_iam_role_policy.wake_launch",
    // no counterpart in the module
    "aws_budgets_budget.daily",
    "aws_budgets_budget.project_total",
    "aws_ce_cost_allocation_tag.box",
    "aws_ce_cost_allocation_tag.project",
    "aws_cloudtrail.tripwire",
    "aws_cloudwatch_event_rule.last_error",
    "aws_cloudwatch_event_rule.tripwire_decoy_key",
    "aws_cloudwatch_event_target.last_error",
    "aws_cloudwatch_event_target.tripwire_decoy_key",
    "aws_cloudwatch_log_metric_filter.control_errors",
    "aws_cloudwatch_log_metric_filter.control_ticks",
    "aws_cloudwatch_log_metric_filter.errors",
    "aws_cloudwatch_log_metric_filter.provision_failed",
    "aws_cloudwatch_metric_alarm.box_errors",
    "aws_cloudwatch_metric_alarm.control_failed_invocations",
    "aws_cloudwatch_metric_alarm.control_logged_errors",
    "aws_cloudwatch_metric_alarm.kill_awake_sum",
    "aws_cloudwatch_metric_alarm.kill_egress",
    "aws_cloudwatch_metric_alarm.kill_log_bytes",
    "aws_cloudwatch_metric_alarm.kill_od_hours",
    "aws_cloudwatch_metric_alarm.kill_park_idle",
    "aws_cloudwatch_metric_alarm.kill_sns_publishes",
    "aws_ec2_tag.persistent_eni",
    "aws_fis_experiment_template.ice_capacity",
    "aws_fis_experiment_template.spot_interrupt",
    "aws_iam_access_key.tripwire_decoy",
    "aws_iam_role.fis",
    "aws_iam_user.tripwire_decoy",
    "aws_iam_user_policy.tripwire_decoy",
    "aws_lambda_permission.alerts_topic",
    "aws_lambda_permission.budget_freeze",
    "aws_s3_bucket.tripwire_trail",
    "aws_s3_bucket_lifecycle_configuration.tripwire_trail",
    "aws_s3_bucket_policy.tripwire_trail",
    "aws_s3_bucket_public_access_block.tripwire_trail",
    "aws_sns_topic.budget_freeze",
    "aws_sns_topic_policy.budget_freeze",
    "aws_sns_topic_subscription.alerts_router",
    "aws_sns_topic_subscription.budget_freeze",
    "aws_ssm_parameter.tripwire_decoy",
    "aws_vpc_endpoint.s3",
    "aws_vpc_security_group_egress_rule.all",
  ]),
];

const RULE_BY_FROM = new Map(LEGACY_RULES.map((r) => [r.from, r]));
const ADDRESS = /^([a-z0-9_]+\.[A-Za-z0-9_-]+)(\[.+\])?$/;

export type PlanOptions = { readonly module?: string | undefined };

function withIndex(rule: Rule, key: string): string {
  const to = rule.to ?? "";
  if (rule.index === "add0") return `${to}[0]`;
  if (rule.index === "strip") return to;
  return `${to}${key}`;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function planMoves(stateList: ReadonlyArray<string>, options: PlanOptions = {}): MovedPlan {
  const modulePrefix = `module.${options.module ?? "dozebox"}.`;
  const moved = new Map<string, string>();
  const removed = new Set<string>();
  const unknown = new Set<string>();
  for (const line of stateList) {
    const address = line.trim();
    if (address === "" || address.startsWith("data.")) continue;
    const match = ADDRESS.exec(address);
    const rule = match ? RULE_BY_FROM.get(match[1] ?? "") : undefined;
    if (!match || !rule) {
      unknown.add(address);
    } else if (rule.to === null) {
      removed.add(match[1] ?? address);
    } else {
      moved.set(address, `${modulePrefix}${withIndex(rule, match[2] ?? "")}`);
    }
  }
  return {
    moved: [...moved].toSorted(([a], [b]) => byText(a, b)).map(([from, to]) => ({ from, to })),
    removed: [...removed].toSorted(byText),
    unknown: [...unknown].toSorted(byText),
  };
}

const HEADER = [
  "# Generated by scripts/gen-moved.ts from `terraform state list` of the old root. Do not edit by hand.",
  "# A `removed` block forgets the object (destroy = false): it stays in AWS until you delete it.",
].join("\n");

export function renderMoved(plan: MovedPlan): string {
  const blocks = [
    ...plan.moved.map((m) => `moved {\n  from = ${m.from}\n  to   = ${m.to}\n}`),
    ...plan.removed.map((from) => `removed {\n  from = ${from}\n\n  lifecycle {\n    destroy = false\n  }\n}`),
  ];
  return `${[HEADER, ...blocks].join("\n\n")}\n`;
}

function moduleFlag(args: ReadonlyArray<string>): string | undefined {
  const at = args.indexOf("--module");
  return at === -1 ? undefined : args[at + 1];
}

if (import.meta.main) {
  const plan = planMoves(readFileSync(0, "utf8").split("\n"), { module: moduleFlag(process.argv.slice(2)) });
  if (plan.unknown.length > 0) {
    for (const address of plan.unknown) console.error(`gen-moved: no rule for ${address}`);
    console.error(`gen-moved: ${plan.unknown.length} address(es) without a rule. Add them to LEGACY_RULES.`);
    process.exit(1);
  }
  process.stdout.write(renderMoved(plan));
}
