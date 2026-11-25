// Helpers shared by the D2 and D3 drills (spot, fallback, kill, restore): they start from a parked warm stack, wake
// it through the CLI, read what `dozebox status` says about the serving instance, and leave the stack parked.
import { MINUTE } from "@dozebox/core/time";
import { DozeboxCliError } from "../command.ts";
import { boxInstances, cliOk, obj, str, waitUntil, type BoxInstance } from "./box.ts";
import { deliverAgent } from "./deliver.ts";
import { wakeToServing } from "./flow.ts";
import { directTick, POLL_MS } from "./tick.ts";
import type { DrillContext } from "./types.ts";

/** Teardown has no step deadline; it gets one budget for everything it does. */
const TEARDOWN_MS = 20 * MINUTE;

export const teardownSignal = (ctx: DrillContext): AbortSignal => ctx.deps.clock.timeout(TEARDOWN_MS);

/** `<name_prefix>-<box_id>`, the name Terraform gives every resource of the box (the control function minus `-control`). */
export async function stackName(ctx: DrillContext): Promise<string> {
  return (await ctx.stack()).controlFunctionName.replace(/-control$/, "");
}

const awake = (i: BoxInstance): boolean => i.state === "pending" || i.state === "running" || i.state === "stopping";

/** Polls until the box has no instance that is starting, running or stopping. */
async function waitNoneRunning(ctx: DrillContext, signal: AbortSignal): Promise<void> {
  await waitUntil(ctx, signal, POLL_MS, async () => ((await boxInstances(ctx, signal)).some(awake) ? null : true));
}

/** `dozebox park --force`, then waits until no instance runs. A park of a parked box is a no-op. */
export async function parkAndWait(ctx: DrillContext, signal: AbortSignal): Promise<void> {
  await cliOk(ctx, ["park", "--force", "--reason", "drill"], signal);
  await directTick(ctx, signal);
  await waitNoneRunning(ctx, signal);
}

/** Runs every cleanup even when an earlier one fails; throws the first error after the last one ran. */
export async function attemptAll(
  ctx: DrillContext,
  cleanups: ReadonlyArray<readonly [string, () => Promise<void>]>,
): Promise<void> {
  let first: unknown = null;
  for (const [what, run] of cleanups) {
    try {
      await run();
    } catch (e) {
      ctx.log(`teardown: ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
      first ??= e;
    }
  }
  if (first !== null) throw first;
}

/** Polls `dozebox status` until the box serves; answers what it serves on. */
export function waitServing(ctx: DrillContext, signal: AbortSignal): Promise<Serving> {
  return waitUntil(ctx, signal, POLL_MS, async () => {
    const s = await cliOk(ctx, ["status"], signal);
    return typeof s["servingSince"] === "string" ? servingOf(s) : null;
  });
}

/**
 * Wakes the box, pushes the agent when `--deliver` is set, and answers the control function's status once it serves.
 * Not `dozebox wake --wait`: a box that cannot download the agent never serves until the drill pushes it.
 */
export const wakeServing = (
  ctx: DrillContext,
  signal: AbortSignal,
  deliver?: typeof deliverAgent,
): Promise<Readonly<Record<string, unknown>>> => wakeToServing(ctx, signal, deliver);

export type Serving = {
  readonly id: string;
  readonly type: string;
  readonly lifecycle: "spot" | "on-demand";
  readonly machine: string | null;
  readonly servingSince: string;
};

/** The serving instance of a `/v1/status` answer; a box that does not serve yet is a failure naming the state. */
export function servingOf(status: Readonly<Record<string, unknown>>): Serving {
  const i = obj(status["instance"]);
  const id = str(i["id"]);
  const servingSince = str(status["servingSince"]);
  const lifecycle = i["lifecycle"];
  if (id === null || servingSince === null || (lifecycle !== "spot" && lifecycle !== "on-demand")) {
    throw new DozeboxCliError("problem", `the box is not serving: state ${str(status["state"]) ?? "unknown"}`);
  }
  return { id, type: str(i["type"]) ?? "", lifecycle, machine: str(status["machine"]), servingSince };
}

/** Fails naming both lifecycles when the box serves on the other one. */
export function expectLifecycle(s: Serving, want: "spot" | "on-demand"): Serving {
  if (s.lifecycle !== want) {
    throw new DozeboxCliError("problem", `${s.id} serves ${s.lifecycle}; expected ${want}`);
  }
  return s;
}
