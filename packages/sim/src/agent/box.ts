// The simulated agent of one instance (part 4 A1-A6, legacy box scripts): boot (attach and mount the data volume, with
// the active tag as the fence), the payload unit with systemd restarts, the health watchdog (`decideHealth`), the
// idle loop (`idleVerdict`), the Spot watcher with the early self-stop on a recorded hand-off, the park with the sleep
// fence (R2), and the 60-minute failsafe. Any agent process can be killed between two of its calls.
import { decideHealth, NEW_HEALTH_STATE, type HealthState } from "@dozebox/core/health";
import { idleVerdict, type IdleVerdict } from "@dozebox/core/idle";
import { decideNoProgress } from "@dozebox/core/wake";
import { NO_PROGRESS_MS } from "../invariants.ts";
import { MEASURED as M } from "../measured.ts";
import type { Rng } from "../prng.ts";
import { AwsFault, Crash, MINUTE, pause, type Proc } from "../world/clock.ts";
import { attachVolume, stopPersistent } from "../world/ec2.ts";
import { setDesired } from "../world/group.ts";
import type { BoxHandle, Instance, Notice, World } from "../world/world.ts";
import type { Control } from "../control/control.ts";
import { CiWaitsPayload } from "./examples/ciWaits.ts";
import { CI_WAITS } from "./examples/names.ts";
import { PayloadModel, type SimPayload, type WakeRequest } from "./payload.ts";
import { Server } from "./server.ts";

type ProcState = { readonly name: string; dead: boolean; calls: number; readonly killAt: number };
type ParkReason = "idle" | "no-progress" | "unhealthy" | "failsafe";

const VIEWING_GRACE_MS = 5 * MINUTE;
const IDLE_CHECK_MS = 30_000;

export class Box implements BoxHandle {
  readonly inst: Instance;
  readonly bootedAt: number;
  dead = false;
  mounted = false;
  parking = false;
  bootFailure: { readonly killed: boolean } | null = null;
  unwellSince: number | undefined = undefined;
  unwellEnd: number | undefined = undefined;
  readonly payload: SimPayload;
  private readonly w: World;
  private readonly control: Control;
  private readonly r: Rng;
  private readonly server: Server;
  private device = false;
  private installed = false;
  private servingAt: number | null = null;
  private lastActivity: number;
  private health: HealthState = NEW_HEALTH_STATE;
  private serveStarts: number[] = [];
  private serveRunning = false;
  private serveStopped = false;
  private notice: Notice | null = null;
  private idleStarted = false;

  constructor(w: World, control: Control, inst: Instance) {
    this.w = w;
    this.control = control;
    this.inst = inst;
    this.bootedAt = w.now;
    this.lastActivity = w.now;
    this.r = w.rng.fork(`box/${inst.id}/${w.now}`);
    this.server = new Server(w, this.log);
    const publish = (req: WakeRequest): void => {
      // The agent publishes a wake request when the payload makes it; it outlives the box (part 4 wakes).
      if (w.cfg.bugs.includes("agent-drops-wake-requests")) return;
      w.at(w.draw(M.cliCallMs), () => void control.state.wakeRequests.push(req), "wake-request");
    };
    this.payload =
      w.cfg.payload === CI_WAITS
        ? new CiWaitsPayload(w, this.r.fork("payload"), publish)
        : new PayloadModel(w, this.r.fork("payload"), publish);
  }

  /** This boot wrote `rec/serving` (the agent's first passing health check), as the judge reads it. */
  get everServed(): boolean {
    return this.servingAt !== null;
  }

  private readonly log = (m: string): void => this.w.log(`${this.inst.id.slice(-6)} ${m}`);

  healthy(): boolean {
    return this.mounted && this.server.healthy();
  }

  serving(): boolean {
    return !this.dead && this.healthy();
  }

  held(): boolean {
    return this.payload.holds().some((h) => h.until > this.w.now);
  }

  /** The newest progress the payload reported: a beat, the end of a hold, or the end of a presence. */
  progressAt(): number {
    const ends = [
      ...this.payload.holds().map((h) => Math.min(h.until, this.w.now)),
      ...this.payload.presence().map((p) => Math.min(p.until, this.w.now)),
    ];
    return Math.max(this.payload.lastProgressAt ?? Number.NEGATIVE_INFINITY, ...ends);
  }

  activity(): void {
    this.lastActivity = this.w.now;
    this.w.lastActivity = this.w.now;
    this.payload.interact();
  }

  crashServer(): void {
    this.server.crash();
  }

  hang(ms: number, sticky: boolean): void {
    this.server.hang(ms, sticky);
  }

  kill(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.payload.stop();
    if (this.servingAt !== null)
      this.w.protocol.push({ at: this.w.now, kind: "park", key: "down", until: this.bootedAt });
    this.log(`box down (${reason})`);
  }

  onVolumeAttached(): void {
    if (!this.dead) this.device = true;
  }

  setNotice(n: Notice): void {
    if (this.dead || this.notice !== null) return;
    this.notice = n;
    // The watcher polls IMDS every 5 s.
    const k = Math.max(1, Math.ceil((n.at - this.bootedAt) / M.imdsPollMs));
    this.w.at(this.bootedAt + k * M.imdsPollMs - this.w.now, () => this.spotUnit(), "spot-poll");
  }

  /** One agent process: killable between calls unless `kills` is false; `onExit` gets 0, 1 or 137 (killed). */
  private run(name: string, body: (p: ProcState) => Proc<number>, onExit?: (code: number) => void, kills = true): void {
    const killed = kills && this.w.cfg.boxKillP > 0 && this.r.chance(this.w.cfg.boxKillP);
    const p: ProcState = { name, dead: false, calls: 0, killAt: killed ? this.r.int(0, 12) : Number.POSITIVE_INFINITY };
    this.w.spawn(`${this.inst.id} ${name}`, body(p), {
      alive: () => !this.dead && !p.dead,
      onDone: (code) => onExit?.(code),
      onCrash: () => {
        if (p.dead && !this.dead) onExit?.(137);
      },
    });
  }

  /** A kill point, then `ms` of work, then `effect`. */
  private *call<T>(p: ProcState, what: string, ms: number, effect: () => T): Proc<T> {
    if (this.dead || p.dead) throw new Crash();
    if (p.calls === p.killAt) {
      p.dead = true;
      this.w.boxKills.push({ at: this.w.now, name: p.name, instanceId: this.inst.id });
      this.log(`${p.name} killed before ${what}`);
      throw new Crash();
    }
    p.calls += 1;
    yield* pause(ms);
    if (this.dead || p.dead) throw new Crash();
    return effect();
  }

  private aws<T>(p: ProcState, what: string, effect: () => T): Proc<T> {
    return this.call(p, what, this.w.draw(M.cliCallMs), effect);
  }

  private step(p: ProcState, what: string): Proc {
    return this.call(p, what, this.w.draw([20, 200]), () => {});
  }

  boot(): void {
    const persistent = this.inst.kind === "persistent";
    this.w.at(this.w.draw(persistent ? M.persistentOsUpMs : M.groupOsUpMs), () => this.osUp(), "os-up");
  }

  private osUp(): void {
    if (this.dead) return;
    this.log("OS up");
    // A resumed persistent instance still has the volume attached: its device node exists from the start.
    if (this.w.volumes.some((v) => v.attachments.some((a) => a.instanceId === this.inst.id && a.state === "attached")))
      this.device = true;
    this.w.at(60 * MINUTE, () => this.failsafe(), "failsafe-timer");
    this.w.at(MINUTE, () => this.watchdog(), "watchdog-timer");
    this.run(
      "attach",
      (p) => this.attach(p),
      (code) => {
        if (this.dead) return;
        if (code !== 0) {
          this.bootFailure = { killed: code === 137 };
          this.log(`attach failed (exit ${code})`);
          return;
        }
        this.installed = true;
        this.w.at(this.w.draw([500, 2000]), () => this.startServe(), "serve-start");
      },
    );
  }

  private *attach(p: ProcState): Proc<number> {
    const w = this.w;
    if (!this.device) {
      const first = yield* this.aws(p, "describe-volumes", () => w.read("volume", w.staleLag(this.r)));
      if (!first.active) return yield* this.fail(p, "the volume is tagged active=false; refusing a stale volume");
      const deadline = w.now + 20 * MINUTE;
      for (;;) {
        const v = yield* this.aws(p, "describe-volume", () => w.read("volume", w.staleLag(this.r)));
        if (v.attachedTo === this.inst.id && v.attachment === "attached") break;
        if (v.attachedTo === null) {
          yield* this.aws(p, "attach-volume", () => {
            try {
              attachVolume(w, v.id, this.inst.id, "agent");
            } catch (error) {
              if (!(error instanceof AwsFault)) throw error;
              this.log(`attach-volume: ${error.name}`);
            }
          });
        }
        // In use elsewhere, attaching or detaching: wait. Never force.
        if (w.now >= deadline) return yield* this.fail(p, "the volume stayed attached elsewhere");
        yield* pause(10_000);
      }
    }
    for (let waited = 0; !this.device; waited += 2000) {
      if (waited >= 120_000) return yield* this.fail(p, "the device did not appear");
      yield* pause(2000);
    }
    yield* this.step(p, "blkid");
    yield* this.step(p, "mountpoint");
    yield* this.call(p, "mount", w.draw([20, 200]), () => {
      this.mounted = true;
      this.log("data volume mounted");
    });
    yield* this.step(p, "chown");
    yield* this.step(p, "chmod");
    return 0;
  }

  /** A boot that gives up writes `rec/last-error` (R3 reads it). */
  private *fail(p: ProcState, text: string): Proc<number> {
    this.log(`attach: ${text}`);
    yield* this.aws(p, "put last-error", () => {
      this.control.state.bootError = { instanceId: this.inst.id, at: this.w.now, text };
    });
    return 1;
  }

  /** The payload unit: systemd restarts it on failure (at most 10 starts in 5 minutes). */
  private startServe(): void {
    if (this.dead || this.serveRunning) return;
    this.serveStopped = false;
    this.serveStarts = this.serveStarts.filter((t) => this.w.now - t < 5 * MINUTE);
    if (this.serveStarts.length >= 10) {
      this.log("serve: start limit reached");
      return;
    }
    this.serveStarts.push(this.w.now);
    this.serveRunning = true;
    this.run(
      "serve",
      (p) => this.serve(p),
      (code) => {
        this.serveRunning = false;
        if (this.dead || this.serveStopped || code === 0) return;
        this.w.at(3000, () => this.startServe(), "serve-restart");
      },
    );
  }

  private *serve(p: ProcState): Proc<number> {
    yield* this.step(p, "exec payload");
    const gen = this.server.start();
    // The agent writes `serving` at the payload's first passing health check, with the instance id (R4, SIM-F15).
    while (!this.server.healthy()) {
      if (this.server.exited(gen)) return 1;
      yield* pause(2000);
    }
    yield* this.aws(p, "put serving", () => {
      this.servingAt = this.w.now;
      this.control.state.serving = { instanceId: this.inst.id, at: this.w.now };
      this.w.protocol.push({ at: this.w.now, kind: "serving", key: this.inst.id });
      this.log("serving");
    });
    this.payload.start(this.w.cfg.bugs.includes("agent-keeps-holds") ? this.w.carriedHolds : []);
    if (!this.idleStarted) {
      this.idleStarted = true;
      this.w.at(IDLE_CHECK_MS, () => this.idle(), "idle");
    }
    while (!this.server.exited(gen)) yield* pause(10_000);
    return this.serveStopped ? 0 : 1;
  }

  private *stopServe(): Proc {
    this.serveStopped = true;
    this.payload.stop();
    yield* this.server.stop();
  }

  private verdict(): IdleVerdict {
    const bugs = this.w.cfg.bugs;
    return idleVerdict({
      now: this.w.now,
      idleMs: this.w.cfg.idleMinutes * MINUTE,
      viewingGraceMs: VIEWING_GRACE_MS,
      servingSince: this.servingAt,
      holds: bugs.includes("agent-ignores-holds") ? [] : this.payload.holds(),
      presence: bugs.includes("agent-ignores-presence") ? [] : this.payload.presence(),
      lastInteractiveAt: bugs.includes("agent-ignores-presence") ? null : this.payload.lastInteractiveAt,
      lastProgressAt: this.payload.lastProgressAt,
      // A protocol payload reports its person as presence; raw activity is the health-only fallback (part 4).
      lastActivityAt: this.w.cfg.agent === "protocol" ? null : this.lastActivity,
    });
  }

  /** Every 30 s: the idle verdict, then the no-progress park (core), on what the payload asked for. */
  private idle(): void {
    if (this.dead) return;
    this.w.at(IDLE_CHECK_MS, () => this.idle(), "idle");
    if (this.parking || this.notice !== null) return;
    const now = this.w.now;
    const bugs = this.w.cfg.bugs;
    const holds = bugs.includes("agent-ignores-holds") ? [] : this.payload.holds();
    const presence = bugs.includes("agent-ignores-presence") ? [] : this.payload.presence();
    if (this.verdict().kind === "idle") return this.park("idle");
    if (this.w.cfg.agent !== "protocol" || bugs.includes("agent-ignores-no-progress")) return;
    const np = decideNoProgress({
      now,
      noProgressMs: NO_PROGRESS_MS,
      servingSince: this.servingAt,
      lastProgressAt: this.payload.lastProgressAt,
      workHold: holds.some((h) => h.kind === "work" && h.until > now),
      interactive: presence.some((p) => p.kind === "interactive" && p.until > now),
    });
    if (np.kind === "park") this.park("no-progress");
  }

  private watchdog(): void {
    if (this.dead) return;
    this.w.at(MINUTE, () => this.watchdog(), "watchdog-timer");
    if (!this.installed || this.parking) return;
    this.run("watchdog", (p) => this.check(p));
  }

  private *check(p: ProcState): Proc<number> {
    yield* this.step(p, "probe");
    const d = decideHealth(this.health, {
      now: this.w.now,
      served: this.servingAt !== null,
      healthy: this.healthy(),
      missedLoops: [],
      netUp: true,
      unitFailed: !this.serveRunning && this.serveStarts.length >= 10,
    });
    this.health = d.state;
    if (d.action.kind === "restart") {
      this.log(`watchdog: restart (${d.action.strikes} strikes)`);
      yield* this.stopServe();
      this.startServe();
    } else if (d.action.kind === "park") {
      this.log(`watchdog: park (${d.action.reason})`);
      this.park("unhealthy");
    }
    return 0;
  }

  /** The 60-minute failsafe: a boot that never served writes why and stops itself. Every 15 minutes after. */
  private failsafe(): void {
    if (this.dead) return;
    this.w.at(15 * MINUTE, () => this.failsafe(), "failsafe-timer");
    if (this.servingAt !== null || this.parking) return;
    this.control.state.bootError = {
      instanceId: this.inst.id,
      at: this.w.now,
      text: "failsafe: not serving 60 minutes after boot",
    };
    this.park("failsafe");
  }

  /** The park (A5): fence before the stop, `desired = asleep` (conditional), stop self, fence after (R2). */
  private park(reason: ParkReason): void {
    if (this.dead || this.parking) return;
    this.parking = true;
    const began = this.w.now;
    this.log(`park (${reason})`);
    this.run(
      "sleep",
      (p) => this.parkProc(p, reason, began),
      (code) => {
        this.parking = false;
        if (code === 0 || this.dead) return;
        // A killed park is restarted (systemd); a refused one is asked again by the next verdict.
        if (code === 137) this.w.at(MINUTE, () => this.park(reason), "park-retry");
      },
      reason !== "failsafe",
    );
  }

  private *parkProc(p: ProcState, reason: ParkReason, began: number): Proc<number> {
    const w = this.w;
    const s = this.control.state;
    yield* this.aws(p, "fence before-stop", () => void (s.fence = { at: w.now, phase: "before-stop" }));
    if (reason === "idle") {
      yield* pause(10_000);
      // Activity during the broadcast wait cancels the idle park (the verdict is taken again).
      if (this.verdict().kind !== "idle") {
        yield* this.aws(p, "fence after-stop", () => void (s.fence = { at: w.now, phase: "after-stop" }));
        return 1;
      }
    }
    if (w.cfg.bugs.includes("agent-double-park")) {
      // A broken agent that reports a park and stops nothing (S2 one-park-per-boot).
      w.protocol.push({ at: w.now, kind: "park", key: reason, until: this.bootedAt });
      return 0;
    }
    if (!w.cfg.bugs.includes("park-leaves-no-record")) {
      const written = yield* this.aws(p, "park", () => this.control.writePark("auto", reason, "agent", began));
      if (!written) {
        this.log("park: a wake came in; staying up");
        yield* this.aws(p, "fence after-stop", () => void (s.fence = { at: w.now, phase: "after-stop" }));
        return 1;
      }
    } else {
      w.hooks.event({ type: "park", at: w.now, by: "agent" });
    }
    w.protocol.push({ at: w.now, kind: "park", key: reason, until: this.bootedAt });
    w.carriedHolds = this.payload.holds();
    yield* this.stopServe();
    yield* this.aws(p, "stop self", () => {
      if (this.inst.kind === "persistent") stopPersistent(w, this.inst.id, "user", "agent");
      else setDesired(w, 0, "agent");
    });
    yield* this.aws(p, "fence after-stop", () => void (s.fence = { at: w.now, phase: "after-stop" }));
    return 0;
  }

  /** On a notice: `reclaim-notice` to the payload, 10 s grace, stop the payload, then the early self-stop. */
  private spotUnit(): void {
    this.run(
      "spot",
      (p) => this.reclaim(p),
      (code) => {
        if (!this.dead && code !== 0) this.w.at(5000, () => this.spotUnit(), "spot-restart");
      },
    );
  }

  private *reclaim(p: ProcState): Proc<number> {
    const w = this.w;
    const noticeAt = this.notice?.at ?? w.now;
    this.payload.reclaimNotice();
    yield* pause(10_000);
    yield* this.stopServe();
    if (this.inst.kind !== "persistent") return 0;
    for (let waited = 0; w.now - noticeAt < 100_000 && waited <= 30_000; waited += 3000) {
      const rec = yield* this.aws(p, "read interruption", () => this.control.state.interruption);
      if (rec !== null && rec.instanceId === this.inst.id && rec.at >= noticeAt - 30_000) {
        yield* this.aws(p, "stop self", () => stopPersistent(w, this.inst.id, "user", "agent-reclaim"));
        this.log("reclaim: stopped early for the replacement");
        return 0;
      }
      yield* pause(3000);
    }
    this.log("reclaim: no hand-off recorded; EC2 stops this instance");
    return 0;
  }
}
