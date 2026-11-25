// `dozebox unfreeze --reason <why>` (L4): starts the unfreeze runbook (SSM Automation) after a kill-switch freeze.
// Needs a person's operator credentials: refused from the box's own role, and an AccessDenied from SSM is refused too.
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { stackOf } from "../context.ts";
import { confirmDestructive, positionals, say, stringOpt } from "../output.ts";

/** `arn:aws:iam::1:role/x` and `arn:aws:sts::1:assumed-role/x/session` both name role `x`. */
function roleName(arn: string): string | null {
  const assumed = /:assumed-role\/([^/]+)\//.exec(arn);
  if (assumed !== null) return assumed[1] ?? null;
  return /:role\/(?:.*\/)?([^/]+)$/.exec(arn)?.[1] ?? null;
}

export const unfreeze: Command = {
  name: "unfreeze",
  summary: "Run the unfreeze runbook after a kill-switch freeze.",
  options: { reason: { type: "string" } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const reason = stringOpt(values, "reason");
    if (reason === undefined || reason.trim() === "") throw new DozeboxCliError("usage", "missing --reason <why>");
    const stack = await stackOf(ctx, values);
    if (stack.unfreeze === null) {
      throw new DozeboxCliError(
        "not-set-up",
        "The stack has no unfreeze_runbook output; update the module and deploy.",
      );
    }
    const { aws, control } = ctx.deps;
    const caller = await aws.callerArn();
    const boxRole = stack.instanceRoleArn === null ? null : roleName(stack.instanceRoleArn);
    if (boxRole !== null && roleName(caller) === boxRole) {
      throw new DozeboxCliError("refused", "unfreeze needs a person's operator credentials, not the box's role");
    }
    const status = await control.status(ctx.signal);
    if (!status.frozen) say(ctx, values, "The control function does not report a freeze; running the runbook anyway.");
    await confirmDestructive(ctx, values, `Lift the kill switch of ${stack.boxId} (${reason})?`);
    let execution: string;
    try {
      execution = await aws.startAutomation(stack.unfreeze.document, stack.unfreeze.parameters);
    } catch (e) {
      if (e instanceof Error && (e as Error & { readonly code?: unknown }).code === "aws_denied") {
        throw new DozeboxCliError("refused", `unfreeze needs the operator role: ${e.message}`, { cause: e });
      }
      throw e;
    }
    say(ctx, values, `Unfreeze runbook started (${execution}). The next wake starts the box.`);
    return { exitCode: EXIT.ok, json: { execution, reason, caller } };
  },
};
