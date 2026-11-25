// D2: `dozebox drill fallback`. A person's wake is served On-Demand when Spot has no capacity, and the next wake goes
// back to Spot. The test user cannot make Spot run out, so the trigger is the control function's own evidence of it:
// the `last-start-error` item (kind capacity) in the state table, written the way the tick writes it, dated 30
// minutes ahead so it is newer than the wake's intent (`at >= desired.since`). The control function then raises the
// fallback group, releases the data volume from the stopped Spot instance and the group's instance attaches it.
// Teardown puts the item back as it was, parks, and sets the group to 0.
import { MINUTE, SECOND } from "@dozebox/core/time";
import { DozeboxCliError } from "../command.ts";
import { aws, arr, boxInstances, cliOk, obj, str, waitUntil } from "./box.ts";
import { deliverAgent } from "./deliver.ts";
import {
  attemptAll,
  expectLifecycle,
  parkAndWait,
  servingOf,
  stackName,
  teardownSignal,
  waitServing,
  wakeServing,
} from "./parked.ts";
import { leaseToken, putKv, readItem, restoreItem, type Item } from "./state-item.ts";
import type { Drill, DrillContext } from "./types.ts";

const KEY = "last-start-error";
const PLANTED_AHEAD_MS = 30 * MINUTE;

type Deliver = typeof deliverAgent;

const text = (ctx: DrillContext, k: string): string => {
  const v = ctx.facts.get(k);
  if (typeof v !== "string") throw new DozeboxCliError("problem", `an earlier step did not record ${k}`);
  return v;
};

async function groupName(ctx: DrillContext): Promise<string> {
  return `${await stackName(ctx)}-od`;
}

/** The group's desired capacity, or null when the stack has no fallback group. */
async function groupDesired(ctx: DrillContext, group: string, signal: AbortSignal): Promise<number | null> {
  const out = await aws(
    ctx,
    ["autoscaling", "describe-auto-scaling-groups", "--auto-scaling-group-names", group],
    signal,
  );
  const g = obj(arr(out["AutoScalingGroups"])[0]);
  return typeof g["DesiredCapacity"] === "number" ? g["DesiredCapacity"] : null;
}

/** Instances the active data volume is attached to. */
async function volumeHolders(ctx: DrillContext, signal: AbortSignal): Promise<ReadonlyArray<string>> {
  const s = await ctx.stack();
  const out = await aws(
    ctx,
    [
      "ec2",
      "describe-volumes",
      "--filters",
      `Name=tag:${s.tagPrefix}:box,Values=${s.boxId}`,
      `Name=tag:${s.tagPrefix}:active,Values=true`,
    ],
    signal,
  );
  const v = obj(arr(out["Volumes"])[0]);
  return arr(v["Attachments"])
    .map(obj)
    .filter((a) => a["State"] === "attached" || a["State"] === "attaching")
    .map((a) => str(a["InstanceId"]) ?? "");
}

/** Puts `last-start-error` back as the drill found it, once. */
async function restoreStartError(ctx: DrillContext, signal: AbortSignal): Promise<void> {
  if (ctx.facts.get("fallback.injected") !== true) return;
  await restoreItem(ctx, KEY, (ctx.facts.get("fallback.saved") as Item | null) ?? null, signal);
  ctx.facts.set("fallback.injected", false);
}

async function lowerGroup(ctx: DrillContext, signal: AbortSignal): Promise<void> {
  const group = await groupName(ctx);
  const desired = await groupDesired(ctx, group, signal);
  if (desired !== null && desired !== 0) {
    await aws(
      ctx,
      ["autoscaling", "set-desired-capacity", "--auto-scaling-group-name", group, "--desired-capacity", "0"],
      signal,
    );
  }
}

export function makeFallbackDrill(deliver: Deliver): Drill {
  return {
    name: "fallback",
    // About 20 minutes of On-Demand t4g.small ($0.0168 an hour) and two short Spot runs.
    estimateUsd: async () => 0.05,
    steps: [
      {
        id: "preflight",
        deadlineMs: 3 * MINUTE,
        run: async (ctx, signal) => {
          const all = await boxInstances(ctx, signal);
          const persistent = all.find((i) => i.group === null);
          if (persistent === undefined || persistent.state !== "stopped" || all.some((i) => i.state !== "stopped")) {
            throw new DozeboxCliError(
              "problem",
              `the box must be parked first: ${all.map((i) => `${i.id} ${i.state}`).join(", ") || "no instance"}`,
            );
          }
          const group = await groupName(ctx);
          const desired = await groupDesired(ctx, group, signal);
          if (desired !== 0)
            throw new DozeboxCliError("problem", `fallback group ${group} is at ${String(desired)}, not 0`);
          ctx.facts.set("fallback.persistent", persistent.id);
        },
      },
      {
        id: "plant-capacity-error",
        deadlineMs: 2 * MINUTE,
        run: async (ctx, signal) => {
          ctx.facts.set("fallback.saved", await readItem(ctx, KEY, signal));
          ctx.facts.set("fallback.injected", true);
          const token = await leaseToken(ctx, signal);
          await putKv(ctx, KEY, { at: ctx.deps.clock.now() + PLANTED_AHEAD_MS, kind: "capacity" }, token, signal);
        },
      },
      {
        id: "wake-on-demand",
        deadlineMs: 25 * MINUTE,
        run: async (ctx, signal) => {
          await cliOk(ctx, ["wake"], signal);
          const group = await groupName(ctx);
          const fallback = await waitUntil(
            ctx,
            signal,
            10 * SECOND,
            async () =>
              (await boxInstances(ctx, signal)).find((i) => i.group === group && i.state === "running") ?? null,
          );
          ctx.facts.set("fallback.instance", fallback.id);
          if (ctx.options.deliver !== null) await deliver(ctx, fallback.id, signal);
          const s = expectLifecycle(await waitServing(ctx, signal), "on-demand");
          if (s.id !== fallback.id) throw new DozeboxCliError("problem", `${s.id} serves, not ${fallback.id}`);
          if (s.machine !== null && s.machine !== "fallback") {
            throw new DozeboxCliError("problem", `status says machine ${s.machine}, expected fallback`);
          }
        },
      },
      {
        id: "volume-moved",
        deadlineMs: 2 * MINUTE,
        run: async (ctx, signal) => {
          const holders = await volumeHolders(ctx, signal);
          if (holders.length !== 1 || holders[0] !== text(ctx, "fallback.instance")) {
            throw new DozeboxCliError("problem", `the data volume is attached to ${holders.join(", ") || "nothing"}`);
          }
        },
      },
      {
        id: "restore-and-park",
        deadlineMs: 15 * MINUTE,
        run: async (ctx, signal) => {
          await restoreStartError(ctx, signal);
          await parkAndWait(ctx, signal);
          const desired = await groupDesired(ctx, await groupName(ctx), signal);
          if (desired !== 0)
            throw new DozeboxCliError("problem", `the fallback group is at ${String(desired)} after the park`);
        },
      },
      {
        id: "wake-on-spot",
        deadlineMs: 15 * MINUTE,
        run: async (ctx, signal) => {
          const s = expectLifecycle(servingOf(await wakeServing(ctx, signal)), "spot");
          if (s.id !== text(ctx, "fallback.persistent")) {
            throw new DozeboxCliError(
              "problem",
              `${s.id} serves, not the persistent ${text(ctx, "fallback.persistent")}`,
            );
          }
          const holders = await volumeHolders(ctx, signal);
          if (holders.length !== 1 || holders[0] !== s.id) {
            throw new DozeboxCliError("problem", `the data volume is attached to ${holders.join(", ") || "nothing"}`);
          }
        },
      },
    ],
    teardown: async (ctx) => {
      const signal = teardownSignal(ctx);
      await attemptAll(ctx, [
        ["restore last-start-error", () => restoreStartError(ctx, signal)],
        ["park", () => parkAndWait(ctx, signal)],
        ["fallback group to 0", () => lowerGroup(ctx, signal)],
      ]);
    },
  };
}

export const fallbackDrill: Drill = makeFallbackDrill(deliverAgent);
