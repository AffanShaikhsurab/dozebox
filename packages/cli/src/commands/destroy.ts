// `dozebox destroy [--no-keep-snapshots]` (L3): parks, snapshots EVERY volume tagged to the box (active, retired and
// strays: inventory #2), waits for them, then `terraform destroy`. Volumes Terraform does not own (restored or retired
// ones) survive destroy; they are listed at the end so nobody pays for them unknowingly.
import { EXIT, type Command } from "../command.ts";
import { stackOf } from "../context.ts";
import { confirmDestructive, isDryRun, positionals, say } from "../output.ts";
import { parkAndWait, waitSnapshots } from "../volumes.ts";

export const destroy: Command = {
  name: "destroy",
  summary: "Snapshot every tagged volume, then terraform destroy.",
  options: { "keep-snapshots": { type: "boolean", default: true } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const stack = await stackOf(ctx, values);
    const { aws, terraform, ids } = ctx.deps;
    const keep = values["keep-snapshots"] !== false;
    const vols = await aws.volumes(stack.boxId);
    const what = keep ? `snapshot ${vols.length} volume(s) first, then` : "NOT snapshot any volume, then";
    await confirmDestructive(
      ctx,
      values,
      `Destroy the stack of box ${stack.boxId} in ${stack.region}: ${what} terraform destroy?`,
    );

    const snapshots: string[] = [];
    if (keep && vols.length > 0) {
      await parkAndWait(ctx, values, "destroy");
      for (const v of vols) snapshots.push(await aws.createSnapshot(v.id, "pre-destroy", ids.random()));
      say(ctx, values, `Snapshots started: ${snapshots.join(", ")}; waiting until they complete...`);
      await waitSnapshots(ctx, values, stack.boxId, snapshots);
    }
    await terraform.destroy(stack.stackDir, ctx.signal);
    const left = isDryRun(values) ? [] : (await aws.volumes(stack.boxId)).map((v) => v.id);
    say(
      ctx,
      values,
      `Destroyed box ${stack.boxId}.${keep ? ` Snapshots kept: ${snapshots.join(", ") || "none"}.` : ""}`,
    );
    if (left.length > 0)
      say(ctx, values, `Volumes not owned by Terraform remain (delete them when sure): ${left.join(", ")}`);
    return { exitCode: EXIT.ok, json: { destroyed: stack.boxId, snapshots, volumesLeft: left } };
  },
};
