// `dozebox rebuild` (L4): the instance is replaced (new launch template version, fresh root disk and first boot) at
// the next wake; the data volume is kept. The control function does it inside its lease (admin `rebuild`), so the
// CLI never terminates an instance itself.
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { stackOf } from "../context.ts";
import { confirmDestructive, positionals, say, stringOpt } from "../output.ts";

export const rebuild: Command = {
  name: "rebuild",
  summary: "Replace the instance and keep the volume.",
  options: { reason: { type: "string" } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const stack = await stackOf(ctx, values);
    const status = await ctx.deps.control.status(ctx.signal);
    if (status.frozen) throw new DozeboxCliError("refused", "The box is frozen; run `dozebox unfreeze` first.");
    await confirmDestructive(
      ctx,
      values,
      `Replace the instance of ${stack.boxId} at its next wake (root disk redone, data volume kept)?`,
    );
    const reason = stringOpt(values, "reason") ?? "operator rebuild";
    await ctx.deps.control.admin({ action: "rebuild", reason });
    say(ctx, values, "Rebuild requested; the next wake launches a new instance.");
    return { exitCode: EXIT.ok, json: { rebuild: true, reason } };
  },
};
