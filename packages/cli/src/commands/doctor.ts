// `dozebox doctor [--fix]`: every check of `doctor/checks.ts`; exit 1 on any failing check. `--fix` repairs what is
// safe to repair (store a missing wake token, re-send a pending email confirmation), then checks again.
import { EXIT, type Command, type CommandContext } from "../command.ts";
import { doctorChecks, type CheckResult, type DoctorInput } from "../doctor/checks.ts";
import { gatherDoctor } from "../doctor/gather.ts";
import { say, type Values } from "../output.ts";
import { ensureWakeToken } from "../token.ts";

const MARK: Readonly<Record<CheckResult["level"], string>> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

const runChecks = (input: DoctorInput): ReadonlyArray<CheckResult> => doctorChecks().map((c) => c.run(input));

function doctorLines(results: ReadonlyArray<CheckResult>): ReadonlyArray<string> {
  const width = Math.max(...results.map((r) => r.id.length));
  return results.map((r) => {
    const fix = r.fix === undefined ? "" : ` (fix: ${r.fix})`;
    return `${MARK[r.level]}  ${r.id.padEnd(width)}  ${r.message}${fix}`;
  });
}

async function applyFixes(ctx: CommandContext, input: DoctorInput, results: ReadonlyArray<CheckResult>) {
  const fixed: string[] = [];
  const stack = input.stack;
  if (stack === null) return fixed;
  const failing = new Set(results.filter((r) => r.level !== "ok" && r.fix !== undefined).map((r) => r.id));
  if (failing.has("token") && (await ensureWakeToken(ctx.deps.aws, stack))) fixed.push("token");
  if (failing.has("alert-email")) {
    for (const s of input.emailSubscriptions ?? []) {
      if (s.pending) await ctx.deps.aws.subscribeEmail(stack.alertTopicArn, s.endpoint);
    }
    fixed.push("alert-email");
  }
  return fixed;
}

/** Runs the doctor and prints its table; `setup` reuses it. */
export async function runDoctor(ctx: CommandContext, values: Values, fix: boolean) {
  let input = await gatherDoctor(ctx, values);
  let results = runChecks(input);
  let fixed: ReadonlyArray<string> = [];
  if (fix) {
    fixed = await applyFixes(ctx, input, results);
    if (fixed.length > 0) {
      input = await gatherDoctor(ctx, values);
      results = runChecks(input);
    }
  }
  for (const l of doctorLines(results)) say(ctx, values, l);
  if (fixed.length > 0) say(ctx, values, `Fixed: ${fixed.join(", ")}`);
  const failed = results.filter((r) => r.level === "fail").length;
  return { results, fixed, failed };
}

export const doctor: Command = {
  name: "doctor",
  summary: "Check tools, credentials, the stack and the alert path.",
  options: { fix: { type: "boolean" } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values) => {
    const { results, fixed, failed } = await runDoctor(ctx, values, values["fix"] === true);
    return { exitCode: failed > 0 ? EXIT.problem : EXIT.ok, json: { checks: results, fixed } };
  },
};
