// The reconcile tick (part 6 §6.3): lease, observe, caps, decideReconcile (core), act. One action per tick. A tick
// without the lease counts `ReconcileSkipped` (another container is reconciling); a finished one counts
// `ReconcileCompleted`, which the `control-quiet` alarm watches.
import { decideReconcile, type Desired } from "@dozebox/core/reconcile";
import { enforceCaps } from "../caps/awake.ts";
import { restoreTestStep } from "../restore-test/tick.ts";
import { act } from "./act.ts";
import { observe } from "./observe.ts";
import type { ActOutcome, TickDeps } from "./types.ts";

export type TickContext = { readonly trigger: "schedule" | "wake" | "event" };

export type TickResult = { readonly kind: "skipped" } | { readonly kind: "done"; readonly outcome: ActOutcome };

export async function tick(deps: TickDeps, ctx: TickContext): Promise<TickResult> {
  const held = await deps.leases.acquire("reconcile");
  if (held === null) {
    deps.metrics.count("ReconcileSkipped", { trigger: ctx.trigger });
    return { kind: "skipped" };
  }
  const now = deps.clock.now();
  const snapshot = await observe(deps, now);
  const caps = await enforceCaps(deps, snapshot, held);
  let desired: Desired = snapshot.desired;
  if (caps?.park === true && desired.want === "awake") {
    const park: Desired = { want: "asleep", since: now, reason: `park:cap:${caps.rule}`, origin: "judge" };
    // "older" means a newer wake or park won meanwhile; the next tick judges that one.
    if ((await deps.desired.write(park)) === "written") desired = park;
    deps.log.log("warn", "cap reached, parking", { rule: caps.rule, awakeMinutes: caps.awakeMinutes });
  }
  const observed = caps?.noOnDemand === true ? { ...snapshot.observed, onDemandAllowed: false } : snapshot.observed;
  const action = decideReconcile(desired, observed);
  const outcome = await act(deps, action, { lease: held, snapshot: { ...snapshot, desired, observed } });
  if (held.mayContinue(deps.clock.now())) {
    // A failed restore step (AWS refused, scratch volume still creating) is retried by the next tick.
    const restore = await restoreTestStep(deps, held.lease.token).catch((e: unknown) => {
      deps.log.log("warn", "restore test step failed", { error: e instanceof Error ? e.name : "unknown" });
      return null;
    });
    const result = restore?.phase === "idle" ? restore.lastResult : null;
    if (result !== null && result.at === now && !result.ok) {
      deps.log.log("warn", "restore test failed", { snapshotId: result.snapshotId, detail: result.detail });
    }
  }
  if (held.mayContinue(deps.clock.now())) {
    // The Lambda timeout bounds the drain; sinks take their own per-call timeouts.
    const after = await deps.afterTick.run(held.lease.token, new AbortController().signal);
    if (after.judge.kind !== "ok") deps.log.log("warn", "outside judge", { verdict: after.judge.kind });
  }
  deps.log.log("info", "reconcile", {
    trigger: ctx.trigger,
    action: action.kind,
    outcome: outcome.kind,
    why: outcome.kind === "acted" ? null : outcome.why,
  });
  deps.metrics.count("ReconcileCompleted", { action: action.kind });
  return { kind: "done", outcome };
}
