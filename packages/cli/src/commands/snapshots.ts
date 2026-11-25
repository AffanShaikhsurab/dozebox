// `dozebox snapshots list|create|delete` (L3): data volume snapshots tagged to the box.
import { toInstant } from "@dozebox/core/time";
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { stackOf } from "../context.ts";
import { confirmDestructive, positionals, say, stringOpt } from "../output.ts";
import { activeVolume, snapshotAndWait } from "../volumes.ts";

const LABEL = /^[A-Za-z0-9 _.:/=+@-]{1,64}$/;

export const snapshotsList: Command = {
  name: "snapshots list",
  summary: "List the box's data volume snapshots, newest first.",
  options: {},
  mode: "operator",
  mutates: false,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const stack = await stackOf(ctx, values);
    const snaps = (await ctx.deps.aws.snapshots(stack.boxId)).toSorted((a, b) => b.startedAt - a.startedAt);
    if (snaps.length === 0) say(ctx, values, "No snapshots.");
    for (const s of snaps) {
      say(
        ctx,
        values,
        `${s.id}  ${s.state.padEnd(9)}  ${toInstant(s.startedAt)}  ${s.volumeId}  ${s.label ?? ""}`.trimEnd(),
      );
    }
    return { exitCode: EXIT.ok, json: { snapshots: snaps } };
  },
};

export const snapshotsCreate: Command = {
  name: "snapshots create",
  summary: "Snapshot the active data volume; waits until completed unless --no-wait.",
  options: { label: { type: "string" }, wait: { type: "boolean", default: true } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const label = stringOpt(values, "label") ?? "manual";
    if (!LABEL.test(label)) throw new DozeboxCliError("usage", "--label is 1 to 64 letters, digits or _ . : / = + @ -");
    const stack = await stackOf(ctx, values);
    const active = activeVolume(await ctx.deps.aws.volumes(stack.boxId));
    if (active === null) throw new DozeboxCliError("problem", "No active data volume; see `dozebox volumes`.");
    if (values["wait"] === false) {
      const id = await ctx.deps.aws.createSnapshot(active.id, label, ctx.deps.ids.random());
      say(ctx, values, `Snapshot ${id} of ${active.id} started.`);
      return { exitCode: EXIT.ok, json: { snapshotId: id, volumeId: active.id, completed: false } };
    }
    const id = await snapshotAndWait(ctx, values, stack, active.id, label);
    say(ctx, values, `Snapshot ${id} completed.`);
    return { exitCode: EXIT.ok, json: { snapshotId: id, volumeId: active.id, completed: true } };
  },
};

export const snapshotsDelete: Command = {
  name: "snapshots delete",
  summary: "Delete one snapshot of the box.",
  options: {},
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    const [id = ""] = positionals(args, ["snapshot-id"]);
    const stack = await stackOf(ctx, values);
    const snap = (await ctx.deps.aws.snapshots(stack.boxId)).find((s) => s.id === id);
    if (snap === undefined) throw new DozeboxCliError("usage", `${id} is not a snapshot of box ${stack.boxId}`);
    await confirmDestructive(ctx, values, `Delete snapshot ${id} of ${snap.volumeId}?`);
    await ctx.deps.aws.deleteSnapshot(id);
    say(ctx, values, `Deleted ${id}.`);
    return { exitCode: EXIT.ok, json: { deleted: id } };
  },
};
