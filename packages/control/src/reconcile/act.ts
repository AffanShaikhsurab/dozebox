// C3: execute one Action. Destructive and billing actions re-read EC2, the fence and the intent first and skip when
// any changed (fence appeared, desired flipped, instance state moved): the snapshot may be seconds old, and EC2
// calls cannot check our fencing token. Tokens come from the intent id (actionToken), never from the clock.
import { RunnerError } from "@dozebox/core/errors";
import type { Action } from "@dozebox/core/reconcile";
import { readRecord } from "@dozebox/core/records";
import { actionToken, type HeldLease } from "../state/index.ts";
import { desiredOrder, KEYS } from "../state/keys.ts";
import type { ActOutcome, Snapshot, TickDeps } from "./types.ts";

type Ctx = { readonly lease: HeldLease; readonly snapshot: Snapshot };

const live = (s: string): boolean => s === "pending" || s === "running";

/** The newest sleep fence time, or null. */
async function fenceAt(deps: TickDeps): Promise<number | null> {
  const raw = await deps.records.get("fence/sleep-requested");
  const r = readRecord("fence/sleep-requested", raw?.value ?? null, null);
  if (r.kind !== "ok" || r.record.phase !== "before-stop") return null;
  const at = Date.parse(r.record.at);
  return Number.isFinite(at) ? at : null;
}

/** Why a start or raise must not run now, or null. */
async function billingBlocked(deps: TickDeps, ctx: Ctx): Promise<string | null> {
  const [desired, fence] = await Promise.all([deps.desired.read(), fenceAt(deps)]);
  if (desired.want !== "awake" || desiredOrder(desired) !== desiredOrder(ctx.snapshot.desired)) {
    return "desired-changed";
  }
  const seen = ctx.snapshot.observed.sleepFence;
  if (fence !== null && (seen === null || fence > seen.at)) return "fence-appeared";
  return null;
}

/** A stop for `asleep` is void once a newer wake arrived; a stop for any other reason (frozen, loser) is not. */
async function stopBlocked(deps: TickDeps, why: string): Promise<string | null> {
  if (why !== "asleep") return null;
  const desired = await deps.desired.read();
  return desired.want === "asleep" ? null : "desired-changed";
}

function startErrorKind(e: unknown): "capacity" | "refused" | "other" {
  if (e instanceof RunnerError && e.code === "aws_capacity") return "capacity";
  if (e instanceof RunnerError && e.code === "aws_conflict") return "refused";
  return "other";
}

export async function act(deps: TickDeps, action: Action, ctx: Ctx): Promise<ActOutcome> {
  if (action.kind === "none" || action.kind === "wait") return { kind: "idle", why: action.why };
  const skip = (why: string): ActOutcome => ({ kind: "skipped", action: action.kind, why });
  if (!ctx.lease.mayContinue(deps.clock.now())) return skip("lease-short");
  const box = deps.config.box.id;
  const token = actionToken(box, String(desiredOrder(ctx.snapshot.desired)), 0);
  const group = ctx.snapshot.groupName;

  switch (action.kind) {
    case "start-persistent": {
      const blocked = await billingBlocked(deps, ctx);
      if (blocked !== null) return skip(blocked);
      const m = await deps.compute.describePersistent(box);
      if (m === null || m.id !== action.id || m.state !== "stopped") return skip("state-changed");
      try {
        await deps.compute.startPersistent(action.id, token);
      } catch (e) {
        const kind = startErrorKind(e);
        await ctx.lease.putFenced(KEYS.lastStartError, { at: deps.clock.now(), kind });
        deps.log.log("warn", "start failed", { kind, error: e instanceof Error ? e.name : "unknown" });
        return skip(`start-error:${kind}`);
      }
      return { kind: "acted", action: action.kind, token };
    }
    case "stop-persistent": {
      const blocked = await stopBlocked(deps, action.why);
      if (blocked !== null) return skip(blocked);
      const m = await deps.compute.describePersistent(box);
      if (m === null || m.id !== action.id || !live(m.state)) return skip("state-changed");
      await deps.compute.stopPersistent(action.id, token);
      return { kind: "acted", action: action.kind, token };
    }
    case "raise-fallback": {
      if (group === null) return skip("no-group");
      const blocked = await billingBlocked(deps, ctx);
      if (blocked !== null) return skip(blocked);
      if ((await deps.compute.describeGroup(group)).desired === 1) return skip("state-changed");
      await deps.compute.setGroupDesired(group, 1, token);
      return { kind: "acted", action: action.kind, token };
    }
    case "lower-fallback": {
      if (group === null) return skip("no-group");
      const blocked = await stopBlocked(deps, action.why);
      if (blocked !== null) return skip(blocked);
      if ((await deps.compute.describeGroup(group)).desired === 0) return skip("state-changed");
      await deps.compute.setGroupDesired(group, 0, token);
      return { kind: "acted", action: action.kind, token };
    }
    case "release-volume":
      // The Volumes port has no detach (the adapters never detach); the hand-off lands with the fallback drills.
      return skip("no-detach-port");
  }
}
