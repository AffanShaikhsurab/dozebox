// D3: `dozebox drill restore`. The weekly restore test, on demand. Default path: make the control function's test due
// (`kv#restore-test` back to idle with a result from the epoch, which the next tick reads as "a week has passed"),
// then wait for the tick to create the volume from the newest snapshot, check it and delete it, and read the verdict.
// The control function closes a test 15 minutes after it starts, so this path takes about 20 minutes. With
// `--extra restore-direct` the drill does the same check itself (the control function may not have the weekly test):
// newest completed snapshot -> volume in the active volume's zone, tagged to the box, not active -> `available` ->
// delete that one volume. Either way exactly one volume stays active and none is left over.
import { MINUTE, SECOND } from "@dozebox/core/time";
import { DozeboxCliError } from "../command.ts";
import { aws, arr, obj, str, waitUntil } from "./box.ts";
import { attemptAll, teardownSignal } from "./parked.ts";
import { leaseToken, putKv, readItem, valueOf } from "./state-item.ts";
import type { Drill, DrillContext, DrillOptions } from "./types.ts";

const KEY = "restore-test";
const direct = (o: DrillOptions): boolean => o.extras.includes("restore-direct");
const control = (o: DrillOptions): boolean => !direct(o);

const text = (ctx: DrillContext, k: string): string => {
  const v = ctx.facts.get(k);
  if (typeof v !== "string") throw new DozeboxCliError("problem", `an earlier step did not record ${k}`);
  return v;
};

type Vol = { readonly id: string; readonly active: boolean; readonly zone: string; readonly state: string };

async function boxVolumes(ctx: DrillContext, signal: AbortSignal): Promise<ReadonlyArray<Vol>> {
  const s = await ctx.stack();
  const out = await aws(
    ctx,
    ["ec2", "describe-volumes", "--filters", `Name=tag:${s.tagPrefix}:box,Values=${s.boxId}`],
    signal,
  );
  return arr(out["Volumes"])
    .map(obj)
    .filter((v) => v["State"] !== "deleted")
    .map((v) => ({
      id: str(v["VolumeId"]) ?? "",
      active: arr(v["Tags"]).some((t) => obj(t)["Key"] === `${s.tagPrefix}:active` && obj(t)["Value"] === "true"),
      zone: str(v["AvailabilityZone"]) ?? "",
      state: str(v["State"]) ?? "",
    }));
}

/** The newest completed snapshot of the box, or null. */
async function newestSnapshot(ctx: DrillContext, signal: AbortSignal): Promise<string | null> {
  const s = await ctx.stack();
  const out = await aws(
    ctx,
    [
      "ec2",
      "describe-snapshots",
      "--owner-ids",
      "self",
      "--filters",
      `Name=tag:${s.tagPrefix}:box,Values=${s.boxId}`,
      "Name=status,Values=completed",
    ],
    signal,
  );
  const newest = arr(out["Snapshots"])
    .map(obj)
    .toSorted((a, b) => Date.parse(str(b["StartTime"]) ?? "") - Date.parse(str(a["StartTime"]) ?? ""))[0];
  return str(newest?.["SnapshotId"]) ?? null;
}

/** Deletes the drill's own scratch volume, and only that: unattached, tagged to the box, not active, tagged to this run. */
async function deleteScratch(ctx: DrillContext, signal: AbortSignal): Promise<void> {
  const id = ctx.facts.get("restore.scratch");
  if (typeof id !== "string" || ctx.facts.get("restore.snapshot") === undefined) return;
  const s = await ctx.stack();
  const out = await aws(ctx, ["ec2", "describe-volumes", "--volume-ids", id], signal);
  const v = obj(arr(out["Volumes"])[0]);
  const tag = (k: string): string | null =>
    str(
      arr(v["Tags"])
        .map(obj)
        .find((t) => t["Key"] === `${s.tagPrefix}:${k}`)?.["Value"],
    );
  if (
    tag("box") !== s.boxId ||
    tag("active") !== "false" ||
    tag("drill") !== ctx.nonce ||
    arr(v["Attachments"]).length > 0
  ) {
    throw new DozeboxCliError("problem", `refusing to delete ${id}: it is not this drill's unattached scratch volume`);
  }
  await aws(ctx, ["ec2", "delete-volume", "--volume-id", id], signal);
  ctx.facts.delete("restore.scratch");
}

export const restoreDrill: Drill = {
  name: "restore",
  // A gp3 volume of the data volume's size for a few minutes up to a quarter of an hour: fractions of a cent.
  estimateUsd: async () => 0.01,
  steps: [
    {
      id: "baseline",
      deadlineMs: 3 * MINUTE,
      run: async (ctx, signal) => {
        const snapshot = await newestSnapshot(ctx, signal);
        if (snapshot === null) throw new DozeboxCliError("problem", "the box has no completed snapshot to restore");
        const vols = await boxVolumes(ctx, signal);
        const active = vols.filter((v) => v.active);
        if (active.length !== 1) {
          throw new DozeboxCliError(
            "problem",
            `${active.length} volumes are active (${active.map((v) => v.id).join(", ")}); expected 1`,
          );
        }
        ctx.facts.set("restore.path", direct(ctx.options) ? "direct" : "control");
        ctx.facts.set("restore.snapshot", snapshot);
        ctx.facts.set("restore.active", active[0]?.id ?? "");
        ctx.facts.set("restore.zone", active[0]?.zone ?? "");
        ctx.facts.set(
          "restore.before",
          vols
            .map((v) => v.id)
            .toSorted()
            .join(","),
        );
      },
    },
    {
      id: "make-due",
      deadlineMs: 2 * MINUTE,
      when: control,
      run: async (ctx, signal) => {
        ctx.facts.set("restore.triggeredAt", String(ctx.deps.clock.now()));
        const state = valueOf(await readItem(ctx, KEY, signal));
        if (state?.["phase"] === "running") return;
        const due = { phase: "idle", lastResult: { at: 0, ok: true, snapshotId: "", detail: "drill: made due" } };
        await putKv(ctx, KEY, due, await leaseToken(ctx, signal), signal);
      },
    },
    {
      id: "verdict",
      deadlineMs: 30 * MINUTE,
      when: control,
      run: async (ctx, signal) => {
        const since = Number(text(ctx, "restore.triggeredAt")) - MINUTE;
        const result = await waitUntil(ctx, signal, 30 * SECOND, async () => {
          const state = valueOf(await readItem(ctx, KEY, signal));
          const last = obj(state?.["lastResult"]);
          return state?.["phase"] === "idle" && typeof last["at"] === "number" && last["at"] >= since ? last : null;
        });
        ctx.facts.set("restore.detail", str(result["detail"]) ?? "");
        if (result["ok"] !== true) {
          throw new DozeboxCliError("problem", `the restore test failed: ${str(result["detail"]) ?? "no detail"}`);
        }
      },
    },
    {
      id: "create-scratch",
      deadlineMs: 3 * MINUTE,
      when: direct,
      run: async (ctx, signal) => {
        const s = await ctx.stack();
        const tags = [
          { Key: `${s.tagPrefix}:box`, Value: s.boxId },
          { Key: `${s.tagPrefix}:active`, Value: "false" },
          { Key: `${s.tagPrefix}:drill`, Value: ctx.nonce },
        ];
        const out = await aws(
          ctx,
          [
            "ec2",
            "create-volume",
            "--snapshot-id",
            text(ctx, "restore.snapshot"),
            "--availability-zone",
            text(ctx, "restore.zone"),
            "--volume-type",
            "gp3",
            "--client-token",
            `drill-${ctx.nonce}`,
            "--tag-specifications",
            JSON.stringify([{ ResourceType: "volume", Tags: tags }]),
          ],
          signal,
        );
        const id = str(out["VolumeId"]);
        if (id === null) throw new DozeboxCliError("aws", "create-volume answered no VolumeId");
        ctx.facts.set("restore.scratch", id);
      },
    },
    {
      id: "scratch-available",
      deadlineMs: 10 * MINUTE,
      when: direct,
      run: async (ctx, signal) => {
        const id = text(ctx, "restore.scratch");
        await waitUntil(ctx, signal, 15 * SECOND, async () => {
          const v = (await boxVolumes(ctx, signal)).find((x) => x.id === id);
          if (v?.state === "error") throw new DozeboxCliError("problem", `${id} went to error`);
          return v?.state === "available" ? true : null;
        });
      },
    },
    {
      id: "delete-scratch",
      deadlineMs: 5 * MINUTE,
      when: direct,
      run: async (ctx, signal) => {
        const id = text(ctx, "restore.scratch");
        await deleteScratch(ctx, signal);
        await waitUntil(ctx, signal, 10 * SECOND, async () =>
          (await boxVolumes(ctx, signal)).some((v) => v.id === id) ? null : true,
        );
      },
    },
    {
      id: "one-active",
      deadlineMs: 5 * MINUTE,
      run: async (ctx, signal) => {
        const before = text(ctx, "restore.before");
        let last = "";
        try {
          await waitUntil(ctx, signal, 15 * SECOND, async () => {
            const vols = await boxVolumes(ctx, signal);
            const active = vols.filter((v) => v.active).map((v) => v.id);
            last = `volumes ${vols
              .map((v) => v.id)
              .toSorted()
              .join(",")}, active ${active.join(",")}`;
            const same =
              vols
                .map((v) => v.id)
                .toSorted()
                .join(",") === before;
            return same && active.length === 1 && active[0] === text(ctx, "restore.active") ? true : null;
          });
        } catch (e) {
          if (!signal.aborted) throw e;
          throw new DozeboxCliError(
            "problem",
            `after the test: ${last} (before: ${before}, active ${text(ctx, "restore.active")})`,
            { cause: e },
          );
        }
      },
    },
  ],
  teardown: async (ctx) => {
    const signal = teardownSignal(ctx);
    await attemptAll(ctx, [["delete the scratch volume", () => deleteScratch(ctx, signal)]]);
  },
};
