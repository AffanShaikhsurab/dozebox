// `dozebox restore <snapshot-id|latest> [--az <az>]` (L3): park, new volume from the snapshot, swap `active` inside
// the lease, old volume retired (kept `retired_volume_days`). The zone defaults to the current active volume's (the
// launch template and subnet already point there), else the instance's; a different `--az` is a move and says so.
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { stackOf } from "../context.ts";
import { confirmDestructive, positionals, say, stringOpt } from "../output.ts";
import { activeVolume, latestSnapshot, restoreVolume } from "../volumes.ts";

const ZONE = /^[a-z]{2}(-[a-z]+)+-\d[a-z]$/;

export const restore: Command = {
  name: "restore",
  summary: "Restore the data volume from a snapshot.",
  options: { az: { type: "string" } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    const [from = ""] = positionals(args, ["snapshot-id|latest"]);
    const az = stringOpt(values, "az");
    if (az !== undefined && !ZONE.test(az))
      throw new DozeboxCliError("usage", `--az ${az} is not a zone like us-east-1a`);
    const stack = await stackOf(ctx, values);
    const { aws, control } = ctx.deps;
    const snaps = await aws.snapshots(stack.boxId);
    const snap = from === "latest" ? latestSnapshot(snaps) : (snaps.find((s) => s.id === from) ?? null);
    if (snap === null) {
      throw new DozeboxCliError(
        "usage",
        from === "latest" ? "No completed snapshot." : `${from} is not a snapshot of box ${stack.boxId}`,
      );
    }
    if (snap.state !== "completed") throw new DozeboxCliError("refused", `${snap.id} is ${snap.state}, not completed`);

    const current = activeVolume(await aws.volumes(stack.boxId));
    const status = await control.status(ctx.signal);
    const zone = az ?? current?.zone ?? status.instance?.az;
    if (zone === undefined)
      throw new DozeboxCliError("usage", "No active volume or instance to take the zone from; pass --az");
    if (status.frozen) throw new DozeboxCliError("refused", "The box is frozen; run `dozebox unfreeze` first.");
    const move = current !== null && current.zone !== zone ? ` (moves the data from ${current.zone} to ${zone})` : "";
    await confirmDestructive(
      ctx,
      values,
      `Park ${stack.boxId} and replace its data volume with one from ${snap.id} in ${zone}${move}? ` +
        `${current === null ? "There is no active volume now." : `${current.id} is kept, tagged retired.`}`,
    );
    if (move !== "") say(ctx, values, `Moving the data volume to ${zone}.`);
    const out = await restoreVolume(ctx, values, stack, { snapshotId: snap.id, zone, reason: `restore ${snap.id}` });
    return { exitCode: EXIT.ok, json: { snapshotId: snap.id, ...out } };
  },
};
