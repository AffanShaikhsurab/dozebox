// The simulated control function: the routes the scenario and the agent call (`/v1/wake`, `/v1/park`, `/v1/status`),
// the EC2 event handler (R1: it only writes records), the reconcile schedule, and async invokes with AWS's two
// retries. Decisions come from @dozebox/core; this file is only the shell around them.
import { countWakes, decidePark, decideWake, WAKE_BUDGET } from "@dozebox/core/wake";
import type { Desired } from "@dozebox/core/reconcile";
import { MEASURED as M } from "../measured.ts";
import { type Proc } from "../world/clock.ts";
import type { Ec2Event, World } from "../world/world.ts";
import { Inv } from "./inv.ts";
import { newControlState, type ControlState } from "./state.ts";
import { bootFailed, tick } from "./tick.ts";

export type WakeAnswer = { readonly status: 202 | 423 | 429 };
export type StatusView = { readonly serving: boolean; readonly failed: boolean };

export class Control {
  readonly state: ControlState = newControlState();
  private readonly w: World;
  private n = 0;

  constructor(w: World) {
    this.w = w;
    w.hooks.ec2Event = (e) => this.async(`ec2:${e.kind}`, (inv) => this.onEc2Event(inv, e));
  }

  /** Run one invocation. `done` gets the result, or null when it crashed or timed out. */
  invoke<T>(label: string, body: (inv: Inv) => Proc<T>, done: (r: T | null) => void, clean = false): void {
    const inv = new Inv(this.w, (this.n += 1), label, clean);
    this.w.spawn(label, body(inv), { onDone: (r) => done(inv.dead ? null : r), onCrash: () => done(null) });
  }

  /** An asynchronous invoke (schedule, EventBridge, a triggered tick): AWS retries a failure twice. */
  async(label: string, body: (inv: Inv) => Proc, attempt = 0): void {
    this.invoke(label, body, (r) => {
      if (r !== null) return;
      if (attempt < 2)
        this.w.at(
          this.w.draw(M.asyncRetryMs[attempt] ?? M.asyncRetryMs[1]),
          () => this.async(label, body, attempt + 1),
          "retry",
        );
      else this.w.log(`${label}: dropped after retries`);
    });
  }

  triggerTick(): void {
    this.async("reconcile", (inv) => tick(this.w, inv, this.state));
  }

  /** The schedule: a tick every minute; EventBridge Scheduler drops a few. */
  schedule(r: { chance: (p: number) => boolean }): void {
    const every = (): void => {
      this.w.at(M.reconcileEveryMs, every, "tick");
      if (!r.chance(this.w.cfg.tickDropP)) this.triggerTick();
    };
    this.w.at(M.reconcileEveryMs, every, "tick");
  }

  private failedNow(s: ControlState): boolean {
    if (s.wakeFailure !== null && s.wakeFailure.at >= s.desired.since) return true;
    return bootFailed(this.w, s);
  }

  /** POST /v1/wake: decideWake, then write `desired` and trigger a tick. Never calls EC2 (R1, SIM-F5). */
  *wake(inv: Inv): Proc<WakeAnswer> {
    const w = this.w;
    const s = this.state;
    // One conditional write (DynamoDB): the read, the decision and the write cannot interleave with a park.
    const d = yield* inv.call("updateDesired", () => {
      // A person's wake after a failed one starts over (stopped_error -> launching).
      const desired: Desired = this.failedNow(s) ? { ...s.desired, want: "asleep" } : s.desired;
      const decision = decideWake({
        now: w.now,
        origin: "person",
        desired,
        frozen: false,
        budget: { ...countWakes(s.wakesAccepted, w.now), ...WAKE_BUDGET },
        breaker: s.breaker,
      });
      if (decision.kind !== "refuse") s.lastWakeAt = w.now;
      if (decision.kind === "accept") {
        s.desired = decision.desired;
        s.wakesAccepted = [...s.wakesAccepted.filter((t) => w.now - t < 86_400_000), w.now];
        w.intentWrites.push({ at: w.now, by: inv.id });
      }
      return decision;
    });
    if (d.kind === "refuse") return { status: d.code === "frozen" ? 423 : 429 };
    if (d.kind === "accept") this.triggerTick();
    return { status: 202 };
  }

  /** POST /v1/park and the agent's park: always written, even when nothing runs (R2, SIM-F8). */
  *park(inv: Inv, origin: Desired["origin"], reason: string, by: "user" | "agent"): Proc {
    if (this.w.cfg.bugs.includes("park-leaves-no-record")) return;
    yield* inv.call("writeDesired", () => this.writePark(origin, reason, by, null));
    this.triggerTick();
  }

  /**
   * The park write itself. `ifNoWakeSince`: a conditional write (the agent's park), refused when a wake was accepted
   * after the park began, so a person's wake is never overwritten by an older idle verdict.
   */
  writePark(origin: Desired["origin"], reason: string, by: "user" | "agent", ifNoWakeSince: number | null): boolean {
    const w = this.w;
    const d = this.state.desired;
    const woken = d.want === "awake" && Math.max(d.since, this.state.lastWakeAt ?? 0) > (ifNoWakeSince ?? Infinity);
    if (woken) return false;
    this.state.desired = decidePark(w.now, origin, reason);
    w.hooks.event({ type: "park", at: w.now, by });
    return true;
  }

  /** R1: a Spot warning or an EC2 stop for capacity only writes the interruption record; the tick acts. */
  private *onEc2Event(inv: Inv, e: Ec2Event): Proc {
    const s = this.state;
    const w = this.w;
    if (e.kind === "warning") {
      const persistent = e.instanceId === w.persistent.id;
      yield* inv.call("writeInterruption", () => {
        s.lastWarningAt = w.now;
        if (persistent) s.interruption = { instanceId: e.instanceId, at: w.now };
      });
    } else {
      const p = yield* inv.call("describeInstance", () => w.read("persistent", inv.lag()));
      if (p.id !== e.instanceId || p.stoppedBy !== "ec2" || p.state !== "stopped") return;
      const at = p.stoppingAt ?? w.now;
      const known = s.interruption;
      if (known !== null && known.instanceId === p.id && known.at >= at - 150_000) return;
      yield* inv.call("writeInterruption", () => void (s.interruption = { instanceId: p.id, at }));
    }
    this.triggerTick();
  }

  /** GET /v1/status, reduced to what the invariants ask: serving now, or failed visibly. */
  status(): StatusView {
    const s = this.state;
    const serving =
      s.desired.want === "awake" &&
      s.serving !== null &&
      [...this.w.boxes.values()].some((b) => b.inst.id === s.serving?.instanceId && b.serving());
    return { serving, failed: this.failedNow(s) };
  }
}
