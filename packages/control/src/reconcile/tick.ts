// The reconcile tick (part 6 §6.3), built by WP-C3: lease, observe, decideReconcile (core), act, caps. This is the
// seam C1 leaves: the handler and the schedule call `tick(deps, ctx)`, and until C3 lands it only logs that it ran
// and acts on nothing (the desired state written by /v1/wake and /v1/park waits for it).
import type { Deps } from "../deps.ts";

export type TickContext = { readonly trigger: "schedule" | "wake" | "event" };

export async function tick(deps: Deps, ctx: TickContext): Promise<void> {
  deps.log.log("warn", "reconcile tick not built yet; nothing acted on", { trigger: ctx.trigger });
}
