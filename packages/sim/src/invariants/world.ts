// The world invariants (port of legacy sim/invariants.mjs): checked against the world's truth after every event
// (safety) and at deadlines (liveness), never against the code's own words. Each rule with several causes ends in a
// class decided from the truth, so a fix to one cause does not hide another. Classes are listed in README.md.
import type { Control } from "../control/control.ts";
import { HOUR, MINUTE } from "../world/clock.ts";
import type { Action, BoxHandle, WakeTruth, World, WorldEvent } from "../world/world.ts";
import { undoClass, unresolvedClass, type Memory } from "./classes.ts";

const WAKE_BUDGET_MS = 15 * MINUTE;
/** A box process killed during boot has the same 15 minutes from the kill (legacy decision 38). */
const WAKE_BUDGET_AFTER_KILL_MS = 15 * MINUTE;
/** A disruption (reclaim, capacity outage, payload fault) restarts the 15 minutes, never past this. */
const WAKE_DISRUPTION_CAP_MS = 45 * MINUTE;
const IDLE_SLACK_MS = 15 * MINUTE;
const LOOP_MS = 15 * MINUTE;
const UNWELL_MS = 25 * MINUTE;
const TWO_BILLING_MS = 10 * MINUTE;
const PARK_SETTLE_MS = 10 * MINUTE;

export type WorldViolation = { readonly rule: string; readonly at: number; readonly message: string };

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const CONTROL = new Set(["control", "control-park"]);

export function createWorldInvariants(w: World, control: Control) {
  const violations: WorldViolation[] = [];
  const m: Memory = {
    lastWake: Number.NEGATIVE_INFINITY,
    lastPark: Number.NEGATIVE_INFINITY,
    lastNotice: Number.NEGATIVE_INFINITY,
    lastServing: Number.NEGATIVE_INFINITY,
    wakeTruth: new Map<number, WakeTruth>(),
  };
  let lastDisruption = Number.NEGATIVE_INFINITY;
  let twoSince: number | null = null;
  let twoCause = "other";
  let controlParkAt = Number.NEGATIVE_INFINITY;
  let controlParkBy: number | null = null;
  const reported = new Set<string>();

  const fail = (rule: string, message: string): void => {
    if (reported.has(rule)) return;
    reported.add(rule);
    violations.push({ rule, at: w.now, message });
    w.log(`VIOLATION ${rule}: ${message}`);
  };

  const undone = (what: string): void => {
    if (m.lastPark <= m.lastWake) return;
    fail(
      `sleep-undone/${undoClass(w, m)}`,
      `${what} at ${clock(w.now)}, after the sleep at ${clock(m.lastPark)} and with no wake since`,
    );
  };

  /** The control function parked the box and relaunched it by itself, with no wake and no reclaim in between. */
  const loop = (what: string): void => {
    if (w.current !== null && w.current.id === controlParkBy) return;
    if (w.now - controlParkAt > LOOP_MS || m.lastWake > controlParkAt || m.lastNotice > controlParkAt) return;
    const p = w.persistent;
    const cause =
      p.stoppedBy === "ec2" && p.stoppingAt !== null && w.now - p.stoppingAt < 18 * MINUTE
        ? "replacing-window"
        : w.now - m.lastNotice < 5 * MINUTE
          ? "handoff-park"
          : "other";
    fail(
      `recovery-loop/${cause}`,
      `${what} at ${clock(w.now)}, ${Math.round((w.now - controlParkAt) / 1000)} s after its own park`,
    );
  };

  const park = (): void => {
    m.lastPark = w.now;
    const at = w.now;
    w.at(
      PARK_SETTLE_MS,
      () => {
        if (m.lastWake > at || at - m.lastNotice < 3 * MINUTE) return;
        if (violations.some((v) => v.rule.startsWith("sleep-undone"))) return;
        const running = w.billing().filter((i) => i.state === "pending" || i.state === "running");
        if (running.length > 0)
          fail(
            "sleep-not-parked",
            `the sleep at ${clock(at)} left ${running.map((i) => i.id).join(", ")} running ${PARK_SETTLE_MS / MINUTE} minutes later`,
          );
      },
      "check-parked",
    );
  };

  const markControlPark = (): void => {
    controlParkAt = w.now;
    controlParkBy = w.current?.id ?? null;
  };

  const action = (e: Action): void => {
    switch (e.type) {
      case "detach":
        if (CONTROL.has(e.actor) && e.instanceState !== "stopped")
          fail(
            `detach-running/${e.startedAt !== null && w.now - e.startedAt < 60_000 ? "stale-reread-after-start" : "unexplained"}`,
            `detach of ${e.volumeId} from ${e.instanceId} while it is ${e.instanceState}`,
          );
        break;
      case "stop":
        if (CONTROL.has(e.actor)) markControlPark();
        if (e.actor === "control" && e.holdsVolume)
          fail("stop-holder", `the control function stopped ${e.id}, which holds the data volume`);
        break;
      case "attach":
        if (!e.active) fail("attach-stale-volume", `${e.instanceId} attached ${e.volumeId}, tagged active=false`);
        break;
      case "setDesired":
        if (e.n < 1 && CONTROL.has(e.actor)) {
          markControlPark();
          if (e.actor === "control" && e.groupHoldsVolume)
            fail("park-holder", "the control function lowered the group while a group instance holds the data volume");
          const p = w.persistent;
          if (
            e.actor === "control" &&
            p.notice &&
            (p.state === "running" || p.state === "stopping") &&
            w.liveGroup().length > 0
          )
            fail(
              "park-during-handoff",
              "the control function lowered the replacement while the interrupted instance holds the volume",
            );
        }
        if (e.n >= 1 && CONTROL.has(e.actor)) {
          undone("the control function raised the group to 1");
          loop("the control function raised the group to 1");
        }
        break;
      case "start":
        undone("the persistent instance was started");
        if (CONTROL.has(e.actor)) loop("the control function started the persistent instance");
        break;
      case "launch":
        break;
    }
  };

  const event = (e: WorldEvent): void => {
    switch (e.type) {
      case "wake-request":
        m.lastWake = e.at;
        m.wakeTruth.set(e.at, e.truth);
        break;
      case "wake":
        // The wake was written now: a park between its request and its write is older than it.
        m.lastWake = Math.max(m.lastWake, w.now);
        obligation(e.at, w.now);
        break;
      case "park":
        park();
        break;
      case "notice":
        lastDisruption = w.now;
        m.lastNotice = w.now;
        break;
      case "disruption":
      case "capacity-back":
        lastDisruption = w.now;
        break;
    }
  };

  /** A wake must end in serving or in a failure the status shows, within the budget. */
  const obligation = (at: number, written: number): void => {
    const deadline = (): number => {
      const stuck = w.boxKills.filter((k) => {
        const inst = w.instances.get(k.instanceId);
        return (
          (k.name === "attach" || k.name === "serve") &&
          inst &&
          (inst.state === "pending" || inst.state === "running") &&
          k.at >= inst.launchedAt
        );
      });
      return stuck.length === 0
        ? at + WAKE_BUDGET_MS
        : Math.max(at + WAKE_BUDGET_MS, Math.min(...stuck.map((k) => k.at)) + WAKE_BUDGET_AFTER_KILL_MS);
    };
    const arm = (due: number): void => {
      w.at(
        due - w.now,
        () => {
          if (m.lastPark > written || m.lastServing >= at) return;
          const next = Math.max(deadline(), Math.min(lastDisruption + WAKE_BUDGET_MS, at + WAKE_DISRUPTION_CAP_MS));
          if (next > w.now) return arm(next);
          const status = control.status();
          const told = w.alerts.some((a) => a.at >= at && a.text.startsWith("Wake failed"));
          if (!status.serving && !status.failed && !told)
            fail(
              `wake-unresolved/${unresolvedClass(w, m, at)}`,
              `the wake at ${clock(at)} is neither serving nor failed ${Math.round((w.now - at) / MINUTE)} minutes later`,
            );
        },
        "check-wake",
      );
    };
    arm(at + WAKE_BUDGET_MS);
  };

  const unwell = (box: BoxHandle): void => {
    if (box.healthy()) {
      if (box.unwellSince !== undefined) box.unwellEnd = w.now;
      box.unwellSince = undefined;
    } else {
      box.unwellSince ??= w.now;
    }
    const killedSleep = (from: number): boolean =>
      w.boxKills.some((k) => k.instanceId === box.inst.id && k.name === "sleep" && k.at > from);
    if (box.unwellSince !== undefined && w.now - box.unwellSince > UNWELL_MS && !killedSleep(box.unwellSince))
      fail(
        "idle-not-parked/unwell",
        `${box.inst.id} has been unwell for ${Math.round((w.now - box.unwellSince) / MINUTE)} minutes and still runs`,
      );
    const idleFrom = Math.max(
      m.lastWake,
      w.lastActivity,
      m.lastNotice,
      box.bootedAt,
      box.unwellEnd ?? Number.NEGATIVE_INFINITY,
    );
    if (
      box.healthy() &&
      w.now - idleFrom > w.cfg.idleMinutes * MINUTE + IDLE_SLACK_MS &&
      !killedSleep(idleFrom) &&
      !box.held()
    )
      fail(
        "idle-not-parked/serving",
        `${box.inst.id} has had no wake, activity or reclaim for ${Math.round((w.now - idleFrom) / MINUTE)} minutes and still runs`,
      );
  };

  const step = (): void => {
    for (const box of w.boxes.values()) if (box.serving()) m.lastServing = w.now;
    const billing = w.billing();
    if (billing.length >= 2) {
      if (twoSince === null) {
        twoSince = w.now;
        const p = billing.find((i) => i.kind === "persistent");
        const g = billing.find((i) => i.kind === "group");
        const concurrent = p && g && Math.abs((p.startedAt ?? p.launchedAt) - g.launchedAt) < 60_000;
        twoCause = concurrent ? "concurrent-start" : w.now - m.lastNotice < 30 * MINUTE ? "handoff" : "other";
      }
      if (w.now - twoSince > TWO_BILLING_MS)
        fail(
          `two-billing/${twoCause}`,
          `${billing.map((i) => `${i.id} ${i.state}`).join(" and ")} billed together since ${clock(twoSince)}`,
        );
    } else {
      twoSince = null;
    }
    for (const box of w.boxes.values()) if (!box.dead && box.everServed && box.inst.state === "running") unwell(box);
  };

  /** The simulated day is over and nobody has worked for hours: nothing may still run. */
  const finish = (): void => {
    const running = w.billing().filter((i) => i.state === "pending" || i.state === "running");
    const since = Number.isFinite(m.lastWake) ? w.now - m.lastWake : Number.POSITIVE_INFINITY;
    if (running.length > 0 && since > HOUR)
      fail(
        "idle-not-parked/end-of-day",
        `${running.map((i) => `${i.id} ${i.state}`).join(", ")} still running at the end of the day`,
      );
  };

  w.hooks.action = action;
  const previous = w.hooks.event;
  w.hooks.event = (e) => {
    previous(e);
    event(e);
  };
  return { violations, step, finish };
}
