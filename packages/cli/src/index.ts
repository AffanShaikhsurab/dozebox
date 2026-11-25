// The CLI's public surface for tests and the testkit fakes. The `dozebox` bin is `main.ts`.
export {
  DozeboxCliError,
  EXIT,
  exitCodeOf,
  stubCommand,
  type CliDeps,
  type CliErrorCode,
  type Command,
  type CommandContext,
  type CommandResult,
  type ExitCode,
} from "./command.ts";
export { COMMANDS } from "./commands/index.ts";
export { doctorChecks, type CheckResult, type DoctorCheck, type DoctorInput } from "./doctor/checks.ts";
export {
  DRILLS,
  fallbackDrill,
  frontDoorDrill,
  killDrill,
  restoreDrill,
  smokeDrill,
  spotDrill,
} from "./drills/catalog.ts";
export { budgetGate, DRILL_BUDGET_SHARE, DrillReport, estimateHourlyUsd, runDrill } from "./drills/run.ts";
export type { Drill, DrillContext, DrillStep } from "./drills/types.ts";
export { dispatch, GLOBAL_OPTIONS, helpText } from "./main.ts";
export type { AwsOps, CliVolumeView, DoctorFacts, EmailSubscription, SnapshotView } from "./ports/aws.ts";
export type { AdminEvent, ControlApi, WakeAnswer } from "./ports/control.ts";
export type { Prompt } from "./ports/prompt.ts";
export type { CliFiles, Terraform, TerraformOutputs } from "./ports/terraform.ts";
export type { ToolName, Tools } from "./ports/tools.ts";
export { missingOutputs, readStack, REQUIRED_OUTPUTS, stackFromOutputs, type StackContext, type UnfreezeRunbook } from "./stack.ts";
