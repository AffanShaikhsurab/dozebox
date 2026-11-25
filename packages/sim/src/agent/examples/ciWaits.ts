// The CI-driven payload model (S3): a run holds the box while it works and beats every 5 minutes; 40% of runs then
// wait on CI (a 30-minute wait hold, a backstop wake every 30 minutes and an event wake at the finish), 20% wait on a
// merge (a 30-minute wait hold, no wake); a person's activity is interactive presence for 15 minutes. Only the trace
// kinds S2 already reads, and every draw comes from the given Rng.
import type { IdleHold, IdlePresence } from "@dozebox/core/idle";
import type { TraceEvent } from "../../invariants.ts";
import type { Rng } from "../../prng.ts";
import { MINUTE } from "../../world/clock.ts";
import type { World } from "../../world/world.ts";
import type { SimPayload, WakeRequest } from "../payload.ts";

const PRESENCE_MS = 15 * MINUTE;
const BEAT_MS = 5 * MINUTE;
const RENEW_MS = 5 * MINUTE;
const HOLD_FOR_MS = 15 * MINUTE;
const WAIT_MS = 30 * MINUTE;
const BACKSTOP_MS = 30 * MINUTE;

export class CiWaitsPayload implements SimPayload {
  lastInteractiveAt: number | null = null;
  lastProgressAt: number | null = null;
  private readonly held = new Map<string, IdleHold>();
  private readonly present = new Map<string, IdlePresence>();
  private readonly w: World;
  private readonly r: Rng;
  private gen = 0;
  private runs = 0;
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

  start(carried: ReadonlyArray<IdleHold> = []): void {
    this.gen += 1;
    if (!this.on) return;
    for (const h of carried) {
      this.held.set(h.key, h);
      this.trace({ kind: "hold", key: h.key, until: h.until });
    }
    if (this.r.chance(0.5)) this.later(this.r.int(1, 10) * MINUTE, () => this.run());
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

  private holdUntil(key: string, kind: "work" | "wait", until: number): void {
    this.held.set(key, { key, kind, until });
    this.trace({ kind: "hold", key, until });
  }

  /** Releasing a hold is the payload's last word on that work: the idle clock runs from here. */
  private release(key: string): void {
    this.held.delete(key);
    this.lastProgressAt = this.w.now;
    this.trace({ kind: "release", key });
  }

  private wake(key: string, at: number): void {
    this.trace({ kind: "wake-request", key, until: at });
    this.publish({ key, at });
  }

  /** One run: a work hold renewed every 5 minutes with a beat, then a CI wait, a merge wait, or the end. */
  private run(): void {
    const n = (this.runs += 1);
    const key = `run:${n}`;
    const endAt = this.w.now + this.r.int(5, 90) * MINUTE;
    this.holdUntil(key, "work", this.w.now + HOLD_FOR_MS);
    const tick = (): void => {
      const now = this.w.now;
      if (now >= endAt) {
        this.release(key);
        const roll = this.r.next();
        if (roll < 0.4) this.ciWait(n);
        else if (roll < 0.6) this.mergeWait(n);
        else this.afterRun();
        return;
      }
      this.lastProgressAt = now;
      this.trace({ kind: "beat" });
      this.holdUntil(key, "work", now + HOLD_FOR_MS);
      this.later(Math.min(BEAT_MS, RENEW_MS), tick);
    };
    this.later(Math.min(BEAT_MS, RENEW_MS), tick);
  }

  /**
   * A CI wait: a 30-minute wait hold, a backstop wake every 30 minutes, and an event wake at the finish. The hold is
   * not renewed, so the box parks after it expires and the wakes bring it back (the sim has no GitHub).
   */
  private ciWait(n: number): void {
    const start = this.w.now;
    const finishAt = start + this.r.int(20, 90) * MINUTE;
    const hold = `ci:${n}`;
    this.holdUntil(hold, "wait", start + WAIT_MS);
    this.wake(`ci-event:${n}`, finishAt);
    const step = (): void => {
      const now = this.w.now;
      if (now >= finishAt) {
        this.release(hold);
        this.afterRun();
        return;
      }
      this.wake(`ci-backstop:${n}`, now + BACKSTOP_MS);
      this.later(BACKSTOP_MS, step);
    };
    step();
  }

  /** A merge wait: a 30-minute wait hold and no wake (a pull request waiting for a person never wakes the box). */
  private mergeWait(n: number): void {
    const hold = `merge:${n}`;
    this.holdUntil(hold, "wait", this.w.now + WAIT_MS);
    this.later(WAIT_MS, () => {
      this.release(hold);
      this.afterRun();
    });
  }

  private afterRun(): void {
    if (this.r.chance(0.3)) this.later(this.r.int(5, 60) * MINUTE, () => this.run());
  }

  holds(): IdleHold[] {
    return [...this.held.values()];
  }

  presence(): IdlePresence[] {
    return [...this.present.values()];
  }
}
