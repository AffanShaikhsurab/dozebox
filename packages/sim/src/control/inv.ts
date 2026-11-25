// One control-function invocation (port of legacy sim/controlPort.mjs): a latency per call (so overlapping invocations
// interleave), a possible crash before any call (every later call then fails, so nothing after it takes effect), and
// the function timeout. Each call's effect runs synchronously with `w.current` set, so the invariants can tell which
// invocation did what.
import { MEASURED as M } from "../measured.ts";
import type { Rng } from "../prng.ts";
import { Crash, pause, type Proc } from "../world/clock.ts";
import type { Invocation, World } from "../world/world.ts";

export class Inv implements Invocation {
  readonly id: number;
  readonly label: string;
  readonly startedAt: number;
  readonly r: Rng;
  readonly clean: boolean;
  dead = false;
  private calls = 0;
  private readonly crashAt: number;
  private readonly deadline: number;
  private readonly w: World;

  constructor(w: World, id: number, label: string, clean: boolean) {
    this.w = w;
    this.id = id;
    this.label = label;
    this.clean = clean;
    this.startedAt = w.now;
    this.r = w.rng.fork(`invocation/${id}`);
    const crashes = !clean && w.cfg.lambdaCrashP > 0 && this.r.chance(w.cfg.lambdaCrashP);
    this.crashAt = crashes ? this.r.int(0, 24) : Number.POSITIVE_INFINITY;
    this.deadline = w.now + M.lambdaTimeoutMs;
  }

  /** One SDK call: wait its latency, then run `effect` as this invocation. */
  *call<T>(name: string, effect: () => T): Proc<T> {
    if (this.dead || this.calls === this.crashAt) {
      this.dead = true;
      throw new Crash(`${this.label} crashed before ${name}`);
    }
    this.calls += 1;
    yield* pause(this.r.range(M.lambdaCallMs));
    if (this.w.now > this.deadline) {
      this.dead = true;
      throw new Crash(`${this.label} timed out in ${name}`);
    }
    this.w.current = this;
    try {
      return effect();
    } finally {
      this.w.current = null;
    }
  }

  /** How stale this call's EC2 read is. */
  lag(): number {
    return this.clean ? 0 : this.w.staleLag(this.r);
  }
}
