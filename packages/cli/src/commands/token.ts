// `dozebox token show|rotate` (L2): the wake token. `show` prints the wake link (token in the URL fragment).
// `rotate` stores a new one; old links stop working once the control function's 60 s token cache expires.
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { stackOf } from "../context.ts";
import { confirmDestructive, positionals, say } from "../output.ts";
import { newWakeToken, wakeLink } from "../token.ts";

export const tokenShow: Command = {
  name: "token show",
  summary: "Print the wake link <control_url>/#t=<token>.",
  options: {},
  mode: "operator",
  mutates: false,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const stack = await stackOf(ctx, values);
    const token = await ctx.deps.aws.getParameter(stack.wakeTokenParameter);
    if (token === null || token === "")
      throw new DozeboxCliError("not-set-up", "No wake token stored; run `dozebox setup`.");
    const link = wakeLink(stack.controlUrl, token);
    say(ctx, values, link);
    return { exitCode: EXIT.ok, json: { link } };
  },
};

export const tokenRotate: Command = {
  name: "token rotate",
  summary: "Store a new wake token; every old wake link stops working.",
  options: {},
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const stack = await stackOf(ctx, values);
    await confirmDestructive(
      ctx,
      values,
      `Rotate the wake token of ${stack.boxId}? Phones and saved wake links need the new link.`,
    );
    const token = newWakeToken();
    await ctx.deps.aws.putParameter(stack.wakeTokenParameter, token, { secure: true });
    const link = wakeLink(stack.controlUrl, token);
    say(ctx, values, `New wake link: ${link}`);
    say(ctx, values, "Old links stop working within a minute.");
    return { exitCode: EXIT.ok, json: { link } };
  },
};
