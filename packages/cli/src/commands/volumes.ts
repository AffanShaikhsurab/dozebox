// `dozebox volumes list|retire <id>` (L4): every volume tagged to the box. A box with no active volume cannot boot
// its data; `list` flags it (exit 1) and prints the fix.
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { stackOf } from "../context.ts";
import { confirmDestructive, positionals, say } from "../output.ts";
import { activeVolume } from "../volumes.ts";

const NO_ACTIVE_FIX = "dozebox restore latest";

export const volumesList: Command = {
  name: "volumes list",
  summary: "List the box volumes; flags a box with no active volume.",
  options: {},
  mode: "operator",
  mutates: false,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const stack = await stackOf(ctx, values);
    const vols = await ctx.deps.aws.volumes(stack.boxId);
    for (const v of vols) {
      const flag = v.active ? "active" : v.retired ? "retired" : "-";
      say(ctx, values, `${v.id}  ${v.zone}  ${v.state.padEnd(9)}  ${flag}`);
    }
    const active = activeVolume(vols);
    if (active === null) {
      say(ctx, values, `No volume is tagged active for box ${stack.boxId}. Fix: ${NO_ACTIVE_FIX}`);
      ctx.stderr(`dozebox: no active data volume; run \`${NO_ACTIVE_FIX}\``);
    }
    const json = { volumes: vols, active: active?.id ?? null, ...(active === null ? { fix: NO_ACTIVE_FIX } : {}) };
    return { exitCode: active === null ? EXIT.problem : EXIT.ok, json };
  },
};

export const volumesRetire: Command = {
  name: "volumes retire",
  summary: "Tag a volume retired (never the active one); it is kept until you delete it.",
  options: {},
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    const [id = ""] = positionals(args, ["volume-id"]);
    const stack = await stackOf(ctx, values);
    const v = (await ctx.deps.aws.volumes(stack.boxId)).find((x) => x.id === id);
    if (v === undefined) throw new DozeboxCliError("usage", `${id} is not a volume of box ${stack.boxId}`);
    if (v.active) throw new DozeboxCliError("refused", `${id} is the active volume; restore another one first`);
    if (v.retired) {
      say(ctx, values, `${id} is already retired.`);
      return { exitCode: EXIT.ok, json: { retired: id, changed: false } };
    }
    await confirmDestructive(ctx, values, `Retire volume ${id} in ${v.zone}?`);
    await ctx.deps.aws.retireVolume(id);
    say(ctx, values, `Retired ${id}.`);
    return { exitCode: EXIT.ok, json: { retired: id, changed: true } };
  },
};
