// The data volume flows shared by snapshots, restore, destroy and move-az (L3, L4). Order rules:
// - restore and move-az park the box first, create the new volume, and only then ask the control function to swap
//   the `active` tag inside its lease, so the box never sees two active volumes or none;
// - destroy snapshots every tagged volume (not only the active one, inventory #2) before terraform destroy.
// Under --dry-run nothing is created, so the waits return at once.
import { MINUTE, SECOND } from "@dozebox/core/time";
import { DozeboxCliError, type CommandContext } from "./command.ts";
import { isDryRun, say, type Values } from "./output.ts";
import type { CliVolumeView, SnapshotView } from "./ports/aws.ts";
import type { StackContext } from "./stack.ts";

const POLL_MS = 15 * SECOND;
const SNAPSHOT_TIMEOUT_MS = 60 * MINUTE;
const VOLUME_TIMEOUT_MS = 10 * MINUTE;
const PARK_TIMEOUT_MS = 15 * MINUTE;

/** The one active volume, null when there is none; two active volumes is a problem a person must look at. */
export function activeVolume(vols: ReadonlyArray<CliVolumeView>): CliVolumeView | null {
  const active = vols.filter((v) => v.active);
  if (active.length > 1) {
    throw new DozeboxCliError(
      "problem",
      `${active.length} volumes are tagged active (${active.map((v) => v.id).join(", ")}); retire all but one`,
    );
  }
  return active[0] ?? null;
}

/** The newest completed snapshot, or null. */
export const latestSnapshot = (snaps: ReadonlyArray<SnapshotView>): SnapshotView | null =>
  snaps.filter((s) => s.state === "completed").toSorted((a, b) => b.startedAt - a.startedAt)[0] ?? null;

/** Polls `check` every POLL_MS until it returns a value, or fails naming `what` after `timeoutMs`. */
async function pollUntil<T>(
  ctx: CommandContext,
  what: string,
  timeoutMs: number,
  check: () => Promise<T | null>,
): Promise<T> {
  const { clock } = ctx.deps;
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v !== null) return v;
    if (clock.now() >= deadline) {
      throw new DozeboxCliError("problem", `Gave up waiting for ${what} after ${Math.round(timeoutMs / MINUTE)} min`);
    }
    await clock.sleep(POLL_MS, ctx.signal);
  }
}

export async function waitSnapshots(
  ctx: CommandContext,
  values: Values,
  boxId: string,
  ids: ReadonlyArray<string>,
): Promise<void> {
  if (isDryRun(values) || ids.length === 0) return;
  await pollUntil(ctx, `snapshot ${ids.join(", ")}`, SNAPSHOT_TIMEOUT_MS, async () => {
    const snaps = await ctx.deps.aws.snapshots(boxId);
    const mine = snaps.filter((s) => ids.includes(s.id));
    const failed = mine.find((s) => s.state === "error");
    if (failed !== undefined) throw new DozeboxCliError("aws", `snapshot ${failed.id} failed`);
    return mine.length === ids.length && mine.every((s) => s.state === "completed") ? true : null;
  });
}

async function waitVolumeAvailable(ctx: CommandContext, values: Values, boxId: string, id: string): Promise<void> {
  if (isDryRun(values)) return;
  await pollUntil(ctx, `volume ${id}`, VOLUME_TIMEOUT_MS, async () => {
    const v = (await ctx.deps.aws.volumes(boxId)).find((x) => x.id === id);
    if (v?.state === "error") throw new DozeboxCliError("aws", `volume ${id} failed to create`);
    return v?.state === "available" ? true : null;
  });
}

/** Parks (holds ignored: a person asked) and waits until the control function reports `parked`. */
export async function parkAndWait(ctx: CommandContext, values: Values, reason: string): Promise<void> {
  const { control } = ctx.deps;
  if ((await control.status(ctx.signal)).state === "parked") return;
  await control.admin({ action: "park", force: true, reason });
  say(ctx, values, "Parking the box...");
  if (isDryRun(values)) return;
  await pollUntil(ctx, "the box to park", PARK_TIMEOUT_MS, async () =>
    (await control.status(ctx.signal)).state === "parked" ? true : null,
  );
}

/** Snapshots `vol` and waits until it completes. Returns the snapshot id. */
export async function snapshotAndWait(
  ctx: CommandContext,
  values: Values,
  stack: StackContext,
  volumeId: string,
  label: string,
): Promise<string> {
  const id = await ctx.deps.aws.createSnapshot(volumeId, label, ctx.deps.ids.random());
  say(ctx, values, `Snapshot ${id} of ${volumeId} started.`);
  await waitSnapshots(ctx, values, stack.boxId, [id]);
  return id;
}

export type RestoreOutcome = { readonly volumeId: string; readonly zone: string; readonly retired: string | null };

/**
 * Park, new volume from `snapshotId` in `zone`, wait until available, swap `active` through the admin event, then
 * check exactly one volume is active and it is the new one.
 */
export async function restoreVolume(
  ctx: CommandContext,
  values: Values,
  stack: StackContext,
  input: { readonly snapshotId: string; readonly zone: string; readonly reason: string },
): Promise<RestoreOutcome> {
  const { aws, control, ids } = ctx.deps;
  const before = activeVolume(await aws.volumes(stack.boxId));
  await parkAndWait(ctx, values, input.reason);
  const volumeId = await aws.createVolume({
    snapshotId: input.snapshotId,
    zone: input.zone,
    boxId: stack.boxId,
    token: ids.random(),
  });
  say(ctx, values, `Volume ${volumeId} from ${input.snapshotId} in ${input.zone} created.`);
  await waitVolumeAvailable(ctx, values, stack.boxId, volumeId);
  await control.admin({ action: "swap-volume", volumeId, reason: input.reason });
  if (!isDryRun(values)) {
    const after = activeVolume(await aws.volumes(stack.boxId));
    if (after?.id !== volumeId) {
      throw new DozeboxCliError(
        "problem",
        `The control function did not make ${volumeId} active (active: ${after?.id ?? "none"}); run dozebox volumes`,
      );
    }
  }
  say(ctx, values, `${volumeId} is the active volume${before === null ? "" : `; ${before.id} is retired`}.`);
  return { volumeId, zone: input.zone, retired: before?.id ?? null };
}
