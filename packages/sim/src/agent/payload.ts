// The payload's side of the local protocol (part 4), as the agent sees it, in `protocol` mode: a person's activity
// becomes interactive presence and a beat; a job takes a `work` hold renewed with keepHold and beats while it runs; a
// finished job may leave a timed wake request; a stuck job keeps a `wait` hold and stops beating. Every request goes to
// the protocol trace the S2 invariants read. In `health-only` mode the payload speaks none of it.
import type { IdleHold, IdlePresence } from "@dozebox/core/idle";
import type { TraceEvent } from "../invariants.ts";
import type { Rng } from "../prng.ts";
import { MINUTE } from "../world/clock.ts";
import type { World } from "../world/world.ts";

const PRESENCE_MS = 10 * MINUTE;
const BEAT_MS = 5 * MINUTE;
const RENEW_MS = 5 * MINUTE;
const HOLD_FOR_MS = 15 * MINUTE;

export type WakeRequest = { readonly key: string; readonly at: number };

export class PayloadModel {
  lastInteractiveAt: number | null = null;
  lastProgressAt: number | null = null;
  private readonly held = new Map<string, IdleHold>();
  private readonly present = new Map<string, IdlePresence>();
  private readonly w: World;
  private readonly r: Rng;
  private gen = 0;
  private jobs = 0;

  private readonly publish: (r: WakeRequest) => void;

  constructor(w: World, r: Rng, publish: (r: WakeRequest) => void) {
    this.w = w;
    this.r = r;
    this.publish = publish;
  }

  private get on(): boolean {
    return this.w.cfg.agent === "protocol";
  }

  private trace(e: Omit<TraceEvent, "at">): void {
    this.w.protocol.push({ at: this.w.now, ...e });
  }

  /** Runs `fn` later only while this start of the payload is still the running one. */
  private later(ms: number, fn: () => void): void {
    const gen = this.gen;
    this.w.at(ms, () => gen === this.gen && fn(), "payload");
  }

  /** The payload process started (it already answers its health check). */
  start(carried: ReadonlyArray<IdleHold> = []): void {
    this.gen += 1;
    if (!this.on) return;
    for (const h of carried) {
      this.held.set(h.key, h);
      this.trace({ kind: "hold", key: h.key, until: h.until });
    }
    if (this.r.chance(0.5)) this.later(this.r.int(1, 10) * MINUTE, () => this.job());
  }

  stop(): void {
    this.gen += 1;
  }

  reclaimNotice(): void {}

  /** A person used the box (the scenario's activity). */
  interact(): void {
    if (!this.on) return;
    const now = this.w.now;
    this.lastInteractiveAt = now;
    this.present.set("interactive:tab", { key: "interactive:tab", kind: "interactive", until: now + PRESENCE_MS });
    this.trace({ kind: "presence", key: "interactive:tab", until: now + PRESENCE_MS });
  }

  private hold(key: string, kind: "work" | "wait"): void {
    const until = this.w.now + HOLD_FOR_MS;
    this.held.set(key, { key, kind, until });
    this.trace({ kind: "hold", key, until });
  }

  /** Releasing a hold is the payload's last word on that work: the idle clock runs from here. */
  private release(key: string): void {
    this.held.delete(key);
    this.lastProgressAt = this.w.now;
    this.trace({ kind: "release", key });
  }

  /** One job: a work hold renewed every 5 minutes and a beat every 5 minutes, sometimes stuck, sometimes a wake request. */
  private job(): void {
    const id = `${(this.jobs += 1)}`;
    const work = `work:${id}`;
    const endAt = this.w.now + this.r.int(5, 90) * MINUTE;
    const stuckAt = this.r.chance(0.1) ? this.w.now + this.r.int(1, 30) * MINUTE : Number.POSITIVE_INFINITY;
    this.hold(work, "work");
    const tick = (): void => {
      const now = this.w.now;
      if (now >= stuckAt) {
        // Stuck: it waits on something that never comes, renewing a wait hold, beating no more.
        if (this.held.has(work)) {
          this.release(work);
          this.hold(`wait:${id}`, "wait");
        } else this.hold(`wait:${id}`, "wait");
        this.later(RENEW_MS, tick);
        return;
      }
      if (now >= endAt) {
        this.release(work);
        if (this.r.chance(0.3)) {
          const key = `wake:${id}`;
          const at = now + this.r.int(60, 240) * MINUTE;
          this.trace({ kind: "wake-request", key, until: at });
          this.publish({ key, at });
        }
        if (this.r.chance(0.3)) this.later(this.r.int(5, 60) * MINUTE, () => this.job());
        return;
      }
      this.lastProgressAt = now;
      this.trace({ kind: "beat" });
      this.hold(work, "work");
      this.later(Math.min(BEAT_MS, RENEW_MS), tick);
    };
    this.later(Math.min(BEAT_MS, RENEW_MS), tick);
  }

  holds(): IdleHold[] {
    return [...this.held.values()];
  }

  presence(): IdlePresence[] {
    return [...this.present.values()];
  }
}
