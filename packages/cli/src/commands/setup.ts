// `dozebox setup [--plan-only]` (L2): re-runnable. terraform init, plan, apply when there are changes, refresh the
// stack context, store the wake token when none is stored, report unconfirmed alert email, then run doctor. Each step
// checks before it changes anything, so running setup twice changes nothing the second time.
import { EXIT, type Command } from "../command.ts";
import { stackDirOf, stackOf } from "../context.ts";
import { positionals, say } from "../output.ts";
import { ensureWakeToken } from "../token.ts";
import { runDoctor } from "./doctor.ts";

export const setup: Command = {
  name: "setup",
  summary: "Re-runnable setup: apply, store the wake token, subscribe alerts, run doctor.",
  options: { "plan-only": { type: "boolean" } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const dir = stackDirOf(values);
    const { terraform, aws } = ctx.deps;
    await terraform.init(dir, ctx.signal);
    const changed = await terraform.plan(dir, {}, ctx.signal);
    if (values["plan-only"] === true) {
      say(ctx, values, changed ? "The plan has changes; run setup without --plan-only to apply." : "No changes.");
      return { exitCode: EXIT.ok, json: { changed, applied: false } };
    }
    if (changed) await terraform.apply(dir, {}, ctx.signal);
    const stack = await stackOf(ctx, values, { refresh: true });
    say(ctx, values, changed ? "Applied." : "Infrastructure up to date.");

    const tokenWritten = await ensureWakeToken(aws, stack);
    say(
      ctx,
      values,
      tokenWritten ? "Wake token stored; `dozebox token show` prints the wake link." : "Wake token present.",
    );
    const pending = (await aws.emailSubscriptions(stack.alertTopicArn)).filter((s) => s.pending);
    for (const s of pending) say(ctx, values, `Confirm the alert email sent to ${s.endpoint} (check spam).`);

    const doc = await runDoctor(ctx, values, false);
    return {
      exitCode: doc.failed > 0 ? EXIT.problem : EXIT.ok,
      json: { applied: changed, tokenWritten, pendingEmail: pending.map((s) => s.endpoint), checks: doc.results },
    };
  },
};
