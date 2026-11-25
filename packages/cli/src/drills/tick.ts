// Direct reconcile tick: after a wake or a park a drill runs the control function's reconcile itself instead of
// waiting up to a minute for the EventBridge Scheduler (terraform/control.tf sends this same payload).
import { devNull } from "node:os";
import { aws } from "./box.ts";
import type { DrillContext } from "./types.ts";

/** What the Scheduler's reconcile target sends; the handler runs one tick for it (packages/control/src/handler.ts). */
export const RECONCILE_EVENT = JSON.stringify({ dozebox: "reconcile", v: 1 });

/** Poll interval of every drill wait that follows a wake or a park. */
export const POLL_MS = 5_000;

/**
 * Invokes alias `live` of the control function with the Scheduler's payload. It only speeds the drill up, so a failed
 * invoke (or a tick that lost the lease) is logged and the wait carries on with the regular schedule.
 */
export async function directTick(ctx: DrillContext, signal: AbortSignal): Promise<void> {
  const fn = (await ctx.stack()).controlFunctionName;
  try {
    const out = await aws(
      ctx,
      [
        "lambda",
        "invoke",
        "--function-name",
        `${fn}:live`,
        "--cli-binary-format",
        "raw-in-base64-out",
        "--payload",
        RECONCILE_EVENT,
        devNull,
      ],
      signal,
    );
    if (typeof out["FunctionError"] === "string") ctx.log(`tick: ${fn}:live answered ${out["FunctionError"]}`);
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    ctx.log(`tick: could not invoke ${fn}:live: ${e instanceof Error ? e.message : String(e)}`);
  }
}
