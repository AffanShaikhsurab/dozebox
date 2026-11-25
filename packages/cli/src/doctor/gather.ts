// Gathers the doctor's facts. Nothing here throws for a missing stack or an unreachable control API: those are
// check results, not errors.
import type { CommandContext } from "../command.ts";
import { DozeboxCliError } from "../command.ts";
import { stackDirOf } from "../context.ts";
import { stringOpt, type Values } from "../output.ts";
import type { ToolName } from "../ports/tools.ts";
import { missingOutputs, readStack, type StackContext } from "../stack.ts";
import type { DoctorInput } from "./checks.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function stackOrMissing(
  ctx: CommandContext,
  values: Values,
): Promise<{ readonly stack: StackContext | null; readonly missing: ReadonlyArray<string> }> {
  const dir = stackDirOf(values);
  try {
    return { stack: await readStack(ctx.deps, dir, { refresh: false }), missing: [] };
  } catch (e) {
    if (!(e instanceof DozeboxCliError) || e.code !== "not-set-up") throw e;
    const outputs = await ctx.deps.terraform.output(dir).catch(() => ({}));
    return { stack: null, missing: missingOutputs(outputs) };
  }
}

export async function gatherDoctor(ctx: CommandContext, values: Values): Promise<DoctorInput> {
  const { deps } = ctx;
  const names: ReadonlyArray<ToolName> = ["aws", "terraform", "node"];
  const versions = await Promise.all(names.map((n) => deps.tools.version(n).catch(() => null)));
  const tools = { aws: versions[0] ?? null, terraform: versions[1] ?? null, node: versions[2] ?? null };
  const [facts, { stack, missing }] = await Promise.all([deps.aws.doctorFacts(), stackOrMissing(ctx, values)]);
  const box = stringOpt(values, "box");
  const usable = stack !== null && (box === undefined || box === stack.boxId) ? stack : null;

  let status: DoctorInput["status"] = null;
  let statusError: string | null = null;
  let tokenPresent: boolean | null = null;
  let emailSubscriptions: DoctorInput["emailSubscriptions"] = null;
  if (usable !== null) {
    const [s, token, subs] = await Promise.allSettled([
      deps.control.status(ctx.signal),
      deps.aws.getParameter(usable.wakeTokenParameter),
      deps.aws.emailSubscriptions(usable.alertTopicArn),
    ]);
    if (s.status === "fulfilled") status = s.value;
    else statusError = message(s.reason);
    if (token.status === "fulfilled") tokenPresent = token.value !== null && token.value !== "";
    if (subs.status === "fulfilled") emailSubscriptions = subs.value;
  }
  return {
    tools,
    facts,
    stack: usable,
    missingOutputs: missing,
    now: deps.clock.now(),
    status,
    statusError,
    tokenPresent,
    emailSubscriptions,
  };
}
