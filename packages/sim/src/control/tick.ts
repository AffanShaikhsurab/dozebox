// The tick of the simulated control function: lease, observe, `decideReconcile` from core (one action), act with a
// re-read before anything that bills or detaches (R1), then the judge (R3). Mirrors part 6 §6.3 and C3's act().
import { decideReconcile, type Action, type Observed } from "@dozebox/core/reconcile";
import { decidePark } from "@dozebox/core/wake";
import { MINUTE, AwsFault, type Proc } from "../world/clock.ts";
import { detachVolume, startPersistent, stopPersistent } from "../world/ec2.ts";
import { setDesired, setOnDemandPercent } from "../world/group.ts";
import type { World } from "../world/world.ts";
import type { Inv } from "./inv.ts";
import type { ControlState } from "./state.ts";

const LEASE_TTL_MS = 60_000;
const WAKE_BUDGET_MS = 15 * MINUTE;
const WAKE_DISRUPTION_CAP_MS = 45 * MINUTE;
const JUDGE_MARGIN_MS = 3 * MINUTE;
const SPOT_MISS_MS = 2 * MINUTE;

function* observe(w: World, inv: Inv, s: ControlState): Proc<Observed> {
  const p = yield* inv.call("describePersistent", () => w.read("persistent", inv.lag()));
  const spot = yield* inv.call("describeSpotRequest", () => w.read("spot", inv.lag()));
  const group = yield* inv.call("describeGroup", () => w.read("group", 0));
  const volume = yield* inv.call("describeVolume", () => w.read("volume", inv.lag()));
  const st = yield* inv.call("readState", () => ({ ...s }));
  return {
    now: w.now,
    persistent: {
      id: p.id,
      state: p.state,
      stoppingAt: p.stoppingAt,
      spotRequest: spot.state,
      launchedAt: p.launchedAt,
    },
    group: { desired: group.desired >= 1 ? 1 : 0, instances: group.instances },
    volume,
    sleepFence: st.fence,
    interruption: st.interruption,
    lastStartError: st.lastStartError,
    frozen: false,
    onDemandAllowed: true,
    lastLaunchAt: st.lastLaunchAt,
  };
}

const startErrorKind = (e: AwsFault): "capacity" | "refused" | "other" =>
  e.name === "InsufficientInstanceCapacity"
    ? "capacity"
    : e.name === "IncorrectSpotRequestState" || e.name === "IncorrectInstanceState"
      ? "refused"
      : "other";

/** The step the decision asked for, after a re-read still agrees (R1). */
function* act(w: World, inv: Inv, s: ControlState, action: Action): Proc {
  if (action.kind === "none" || action.kind === "wait") return;
  const again = decideReconcile(s.desired, yield* observe(w, inv, s));
  if (again.kind !== action.kind) {
    w.log(`tick#${inv.id}: re-read changed ${action.kind} to ${again.kind}; skipped`);
    return;
  }
  const park = (again.kind === "stop-persistent" || again.kind === "lower-fallback") && again.why !== "loser";
  switch (again.kind) {
    case "start-persistent":
      try {
        yield* inv.call("startInstances", () => startPersistent(w, again.id, "control"));
      } catch (error) {
        if (!(error instanceof AwsFault)) throw error;
        const kind = startErrorKind(error);
        w.log(`tick#${inv.id}: StartInstances failed: ${error.name}`);
        yield* inv.call("writeStartError", () => void (s.lastStartError = { at: w.now, kind }));
      }
      return;
    case "raise-fallback":
      // Smallest model: the fallback serves on On-Demand unless it replaces an interrupted Spot instance. The raise
      // goes first, right after the re-read; the launch takes seconds, so the mix is set before it.
      yield* inv.call("setDesired", () => setDesired(w, 1, "control"));
      yield* inv.call("setOnDemand", () => setOnDemandPercent(w, again.why === "interrupted" ? 0 : 100));
      yield* inv.call("writeLaunch", () => void (s.lastLaunchAt = w.now));
      return;
    case "lower-fallback":
      yield* inv.call("setDesired", () => setDesired(w, 0, park ? "control-park" : "control"));
      return;
    case "stop-persistent":
      yield* inv.call("stopInstances", () => stopPersistent(w, again.id, "user", park ? "control-park" : "control"));
      return;
    case "release-volume":
      try {
        yield* inv.call("detachVolume", () => detachVolume(w, again.volumeId, again.from, "control"));
      } catch (error) {
        if (!(error instanceof AwsFault)) throw error;
        w.log(`tick#${inv.id}: DetachVolume failed: ${error.name}`);
      }
      return;
  }
}

/**
 * A boot gave up for this wake: its `rec/last-error` is newer than the wake, or comes from the instance still up
 * (R4: the record names its instance).
 */
export function bootFailed(w: World, s: ControlState): boolean {
  const e = s.bootError;
  if (w.cfg.bugs.includes("boot-error-hidden") || e === null) return false;
  const inst = w.instances.get(e.instanceId);
  const thisBoot =
    inst !== undefined && (inst.state === "pending" || inst.state === "running") && e.at >= inst.launchedAt;
  return e.at >= s.desired.since || thisBoot;
}

/** R3: a wake is serving, or failed visibly, within 15 minutes (45 at most across disruptions). */
function* judge(w: World, inv: Inv, s: ControlState): Proc {
  const d = s.desired;
  if (d.want !== "awake" || (s.wakeFailure !== null && s.wakeFailure.at >= d.since)) return;
  // Served means an instance that is still up wrote `rec/serving` for this wake (R4), not an earlier boot.
  const servedBy = s.serving === null ? undefined : w.instances.get(s.serving.instanceId)?.state;
  if (s.serving !== null && s.serving.at >= d.since && (servedBy === "pending" || servedBy === "running")) return;
  const hidden = w.cfg.bugs.includes("boot-error-hidden");
  let reason: string | null = null;
  const failedBoot = bootFailed(w, s);
  if (failedBoot) reason = `boot failed: ${s.bootError?.text}`;
  else {
    // Measured from the wake, not from the last serve (SIM-F7). A box that served and then went away (reclaim,
    // replacement) owes a serving box within the same budget from the newest wake or interruption after that serve.
    const disrupted = Math.max(s.interruption?.at ?? 0, s.lastStartError?.at ?? 0, s.lastWarningAt ?? 0);
    const servedAt = s.serving !== null && s.serving.at >= d.since ? s.serving.at : null;
    const after = (t: number | null): number => (t !== null && servedAt !== null && t > servedAt ? t : 0);
    const from = servedAt === null ? d.since : Math.max(servedAt, after(s.lastWakeAt), after(disrupted));
    // The judge reports before the 15 minutes run out: it runs on the minute tick.
    const budget = hidden ? WAKE_DISRUPTION_CAP_MS : WAKE_BUDGET_MS - JUDGE_MARGIN_MS;
    const due = Math.max(from + budget, Math.min(disrupted + budget, from + WAKE_DISRUPTION_CAP_MS - JUDGE_MARGIN_MS));
    if (w.now >= due) reason = "neither serving nor failed in time";
  }
  if (reason === null) return;
  const text = `Wake failed: ${reason}`;
  yield* inv.call("writeWakeFailure", () => void (s.wakeFailure = { at: w.now, reason }));
  yield* inv.call("publish", () => void w.alerts.push({ at: w.now, text }));
  w.log(`tick#${inv.id}: ${text}`);
  // A boot that gave up cannot recover by itself: park it (stopped_error); a person's next wake starts over.
  if (failedBoot)
    yield* inv.call("writeDesired", () => {
      s.desired = decidePark(w.now, "judge", "wake-failed");
      w.hooks.event({ type: "park", at: w.now, by: "judge" });
    });
}

/** A Spot group that has launched nothing for 2 minutes switches to On-Demand (legacy `nextAfterSpotMiss`). */
function* onDemandAfterSpotMiss(w: World, inv: Inv, s: ControlState): Proc {
  if (s.desired.want !== "awake" || s.lastLaunchAt === null || w.now - s.lastLaunchAt < SPOT_MISS_MS) return;
  const g = yield* inv.call("describeGroup", () => ({ ...w.group, live: w.liveGroup().length }));
  if (g.desired < 1 || g.live > 0 || g.onDemandPercent === 100) return;
  w.log(`tick#${inv.id}: no Spot launch for ${SPOT_MISS_MS / 60_000} min; group to On-Demand`);
  yield* inv.call("setOnDemand", () => setOnDemandPercent(w, 100));
}

export function* tick(w: World, inv: Inv, s: ControlState): Proc {
  const token = yield* inv.call("acquireLease", () => {
    const l = s.lease;
    if (l !== null && l.expiresAt > w.now && l.holder !== inv.id) return null;
    s.lease = { holder: inv.id, expiresAt: w.now + LEASE_TTL_MS, token: (l?.token ?? 0) + 1 };
    return s.lease.token;
  });
  if (token === null) return;
  yield* onDemandAfterSpotMiss(w, inv, s);
  const action = decideReconcile(s.desired, yield* observe(w, inv, s));
  if (action.kind !== "none") w.log(`tick#${inv.id}: ${JSON.stringify(action)}`);
  yield* act(w, inv, s, action);
  yield* judge(w, inv, s);
  yield* inv.call("releaseLease", () => {
    if (s.lease?.token === token) s.lease = null;
  });
}
