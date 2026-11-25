// The simulated clock: an event queue and processes written as generators. A process yields `{ ms }` to sleep; the
// clock resumes it later, unless its `alive()` check says it died meanwhile (a killed box or invocation simply never
// resumes). Everything is synchronous, so one seed runs without the event loop and replays byte for byte.

export const EPOCH = Date.parse("2026-11-24T00:00:00Z");
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

type Wait = { readonly ms: number };
/** A simulated process. `yield* pause(ms)` sleeps. */
export type Proc<T = void> = Generator<Wait, T, void>;

export function* pause(ms: number): Proc {
  yield { ms };
}

/** A killed control invocation or agent process. Never a finding by itself. */
export class Crash extends Error {
  constructor(message = "crashed") {
    super(message);
    this.name = "Crash";
  }
}

/** An AWS error: `name` is the AWS error code. */
export class AwsFault extends Error {
  constructor(name: string, message = name) {
    super(message);
    this.name = name;
  }
}

type Item = { t: number; seq: number; fn: () => void; label: string; cancelled: boolean };
export type Timer = { readonly cancel: () => void; readonly at: number };

const before = (a: Item, b: Item): boolean => a.t < b.t || (a.t === b.t && a.seq < b.seq);

class Heap {
  private readonly items: Item[] = [];
  size(): number {
    return this.items.length;
  }
  peek(): Item | undefined {
    return this.items[0];
  }
  push(item: Item): void {
    const h = this.items;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const a = h[i] as Item;
      const b = h[parent] as Item;
      if (!before(a, b)) break;
      h[i] = b;
      h[parent] = a;
      i = parent;
    }
  }
  pop(): Item | undefined {
    const h = this.items;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0 && last !== undefined) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && before(h[l] as Item, h[m] as Item)) m = l;
        if (r < h.length && before(h[r] as Item, h[m] as Item)) m = r;
        if (m === i) break;
        const tmp = h[i] as Item;
        h[i] = h[m] as Item;
        h[m] = tmp;
        i = m;
      }
    }
    return top;
  }
}

export type SpawnOptions<T> = {
  /** Checked before every resume; false means the process died silently. */
  readonly alive?: () => boolean;
  readonly onDone?: (value: T) => void;
  /** A Crash thrown inside the process. */
  readonly onCrash?: () => void;
};

export class Clock {
  now = EPOCH;
  readonly errors: Array<{ readonly name: string; readonly error: unknown }> = [];
  readonly trace: string[] = [];
  private readonly queue = new Heap();
  private seq = 0;

  log(message: string): void {
    this.trace.push(`${new Date(this.now).toISOString().slice(11, 19)} ${message}`);
    if (this.trace.length > 4000) this.trace.splice(0, 2000);
  }

  at(delayMs: number, fn: () => void, label = ""): Timer {
    const item: Item = { t: this.now + Math.max(0, delayMs), seq: (this.seq += 1), fn, label, cancelled: false };
    this.queue.push(item);
    return { cancel: () => void (item.cancelled = true), at: item.t };
  }

  spawn<T>(name: string, proc: Proc<T>, opts: SpawnOptions<T> = {}): void {
    const step = (): void => {
      if (opts.alive && !opts.alive()) return;
      let r: IteratorResult<Wait, T>;
      try {
        r = proc.next();
      } catch (error) {
        if (error instanceof Crash) opts.onCrash?.();
        else this.fail(name, error);
        return;
      }
      if (r.done) opts.onDone?.(r.value);
      else this.at(r.value.ms, step, name);
    };
    step();
  }

  fail(name: string, error: unknown): void {
    this.errors.push({ name, error });
    this.log(`MODEL ERROR ${name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }

  run(untilMs: number, afterStep?: (label: string) => void): void {
    for (;;) {
      const top = this.queue.peek();
      if (top === undefined || top.t > untilMs) break;
      this.queue.pop();
      if (top.cancelled) continue;
      this.now = top.t;
      try {
        top.fn();
      } catch (error) {
        this.fail(top.label, error);
      }
      afterStep?.(top.label);
      if (this.errors.length > 0) return;
    }
    this.now = Math.max(this.now, untilMs);
  }
}
