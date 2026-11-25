// Drill flows several drills share: wake to serving (pushing the agent when asked), park and wait.
import { arr, cliOk, obj, record, runningInstance, str, waitUntil } from "./box.ts";
import { deliverAgent } from "./deliver.ts";
import { directTick, POLL_MS } from "./tick.ts";
import type { DrillContext } from "./types.ts";

export type Status = Readonly<Record<string, unknown>>;

export async function controlStatus(ctx: DrillContext, signal: AbortSignal): Promise<Status> {
  return cliOk(ctx, ["status"], signal);
}

/** Wake, push the agent when asked, and wait until the control status says serving. */
export async function wakeToServing(ctx: DrillContext, signal: AbortSignal): Promise<Status> {
  await cliOk(ctx, ["wake"], signal);
  await directTick(ctx, signal);
  if (ctx.options.deliver !== null) {
    const i = await waitUntil(ctx, signal, POLL_MS, () => runningInstance(ctx, signal).catch(() => null));
    await deliverAgent(ctx, i.id, signal);
  }
  const s = await waitUntil(ctx, signal, POLL_MS, async () => {
    const st = await controlStatus(ctx, signal);
    return str(st["servingSince"]) === null ? null : st;
  });
  const instance = obj(s["instance"]);
  ctx.facts.set("lifecycles", [...new Set([...arr(ctx.facts.get("lifecycles")), instance["lifecycle"]])]);
  ctx.facts.set("types", [...new Set([...arr(ctx.facts.get("types")), instance["type"]])]);
  return s;
}

/** Waits until no instance of the box runs; returns the newest last-words record. */
export async function waitParked(ctx: DrillContext, signal: AbortSignal): Promise<Status> {
  await waitUntil(ctx, signal, POLL_MS, async () => {
    const st = await controlStatus(ctx, signal);
    return st["state"] === "parked" ? true : null;
  });
  return (await record(ctx, "last-words", signal)) ?? {};
}

export async function parkForce(ctx: DrillContext, signal: AbortSignal, reason = "drill"): Promise<Status> {
  await cliOk(ctx, ["park", "--force", "--reason", reason], signal);
  await directTick(ctx, signal);
  return waitParked(ctx, signal);
}
