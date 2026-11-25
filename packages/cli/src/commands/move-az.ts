// `dozebox move-az <az>` (L4): for capacity trouble in one zone. Parks, snapshots the active volume, creates the new
// volume from that (latest) snapshot in the target zone and swaps `active` inside the lease; the old one is retired.
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { stackOf } from "../context.ts";
import { confirmDestructive, positionals, say } from "../output.ts";
import { activeVolume, parkAndWait, restoreVolume, snapshotAndWait } from "../volumes.ts";

const ZONE = /^[a-z]{2}(-[a-z]+)+-\d[a-z]$/;

export const moveAz: Command = {
  name: "move-az",
  summary: "Move the data volume to another availability zone.",
  options: {},
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    const [zone = ""] = positionals(args, ["az"]);
    if (!ZONE.test(zone)) throw new DozeboxCliError("usage", `${zone} is not a zone like us-east-1b`);
    const stack = await stackOf(ctx, values);
    if (!zone.startsWith(stack.region)) throw new DozeboxCliError("usage", `${zone} is not in ${stack.region}`);
    const current = activeVolume(await ctx.deps.aws.volumes(stack.boxId));
    if (current === null) throw new DozeboxCliError("problem", "No active data volume to move; see `dozebox volumes`.");
    if (current.zone === zone) throw new DozeboxCliError("usage", `${current.id} is already in ${zone}`);
    if ((await ctx.deps.control.status(ctx.signal)).frozen) {
      throw new DozeboxCliError("refused", "The box is frozen; run `dozebox unfreeze` first.");
    }
    await confirmDestructive(
      ctx,
      values,
      `Park ${stack.boxId}, snapshot ${current.id} and move the data volume from ${current.zone} to ${zone}?`,
    );
    await parkAndWait(ctx, values, `move-az ${zone}`);
    const snapshotId = await snapshotAndWait(ctx, values, stack, current.id, `move-az ${zone}`);
    const out = await restoreVolume(ctx, values, stack, { snapshotId, zone, reason: `move-az ${zone}` });
    say(ctx, values, `The next wake launches in ${zone}.`);
    return { exitCode: EXIT.ok, json: { from: current.zone, snapshotId, ...out } };
  },
};
