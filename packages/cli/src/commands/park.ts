// `dozebox park`: the admin `park` event (operator IAM through `lambda invoke`). `--force` ignores holds.
import { EXIT, type Command } from "../command.ts";
import { say, stringOpt } from "../output.ts";

export const park: Command = {
  name: "park",
  summary: "Ask the control function to park the box.",
  options: { force: { type: "boolean" }, reason: { type: "string" } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values) => {
    const force = values["force"] === true;
    const reason = stringOpt(values, "reason") ?? "operator";
    const answer = await ctx.deps.control.admin({ action: "park", force, reason });
    say(
      ctx,
      values,
      force ? "Park requested (holds ignored)." : "Park requested; the box parks once no hold keeps it.",
    );
    return { exitCode: EXIT.ok, json: { requested: true, force, reason, answer } };
  },
};
