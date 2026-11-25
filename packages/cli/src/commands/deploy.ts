// `dozebox deploy`: terraform init, plan, and apply when the plan has changes, in the stack directory; then refresh
// the cached stack context. A plan without changes applies nothing, so deploy twice changes nothing.
import { EXIT, type Command } from "../command.ts";
import { stackDirOf, stackOf } from "../context.ts";
import { say } from "../output.ts";

export const deploy: Command = {
  name: "deploy",
  summary: "Run terraform init and apply in the stack directory.",
  options: { "plan-only": { type: "boolean" } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values) => {
    const dir = stackDirOf(values);
    const { terraform } = ctx.deps;
    await terraform.init(dir, ctx.signal);
    const changed = await terraform.plan(dir, {}, ctx.signal);
    if (!changed) say(ctx, values, "No changes.");
    if (values["plan-only"] === true) return { exitCode: EXIT.ok, json: { changed, applied: false } };
    if (changed) await terraform.apply(dir, {}, ctx.signal);
    const stack = await stackOf(ctx, values, { refresh: true });
    if (changed) say(ctx, values, `Applied. Box ${stack.boxId} in ${stack.region}; control ${stack.controlUrl}`);
    return { exitCode: EXIT.ok, json: { changed, applied: changed, box: stack.boxId, region: stack.region } };
  },
};
