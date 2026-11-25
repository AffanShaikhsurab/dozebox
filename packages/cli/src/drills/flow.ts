// Drill flows several drills share: wake to serving (pushing the agent when asked), park and wait.
import { arr, cliOk, obj, record, runningInstance, shell, str, waitUntil } from "./box.ts";
import { deliverAgent } from "./deliver.ts";
import { directTick, POLL_MS } from "./tick.ts";
import type { DrillContext } from "./types.ts";

export type Status = Readonly<Record<string, unknown>>;

export async function controlStatus(ctx: DrillContext, signal: AbortSignal): Promise<Status> {
  return cliOk(ctx, ["status"], signal);
}

/** Wake, push the agent when asked, and wait until the control status says serving. */
export async function wakeToServing(
  ctx: DrillContext,
  signal: AbortSignal,
  deliver: typeof deliverAgent = deliverAgent,
): Promise<Status> {
  await cliOk(ctx, ["wake"], signal);
  await directTick(ctx, signal);
  if (ctx.options.deliver !== null) {
    const i = await waitUntil(ctx, signal, POLL_MS, () => runningInstance(ctx, signal).catch(() => null));
    await deliver(ctx, i.id, signal);
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

/** A person's sleep request on the box: `POST /v1/sleep {"reason":"user","force":true}` on the admin socket. */
const SLEEP_BY_USER =
  "curl -sS --fail-with-body --max-time 10 --unix-socket /run/dozebox/admin.sock -X POST " +
  "-H 'content-type: application/json' -H 'x-dozebox-payload: marker' " +
  `-d '{"reason":"user","force":true}' http://box/v1/sleep`;

/**
 * A person's sleep request on the box (`/v1/sleep`): the agent parks itself and writes last-words "user".
 * `dozebox park` from the operator only sets desired = asleep; the control function then stops the instance without
 * the agent writing last-words, so it cannot prove a park by user.
 */
export async function parkByUser(ctx: DrillContext, signal: AbortSignal): Promise<Status> {
  const i = await runningInstance(ctx, signal);
  await shell(ctx, i.id, SLEEP_BY_USER, signal);
  await directTick(ctx, signal);
  return waitParked(ctx, signal);
}

export async function parkForce(ctx: DrillContext, signal: AbortSignal, reason = "drill"): Promise<Status> {
  await cliOk(ctx, ["park", "--force", "--reason", reason], signal);
  await directTick(ctx, signal);
  return waitParked(ctx, signal);
}
