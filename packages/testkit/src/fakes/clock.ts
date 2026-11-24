import type { Clock } from "@dozebox/core/time";

export type FakeClock = Clock & {
  /** Move time forward by `ms`, firing every timer that falls due, in time order, at its own time. */
  readonly advance: (ms: number) => void;
  /** Move time forward to the next timer and fire it. Returns false when no timer is pending. */
  readonly next: () => boolean;
  /** Timers that have not fired or been cancelled. */
  readonly pending: () => number;
};

type Timer = { readonly at: number; readonly seq: number; readonly fire: () => void };

/** A clock that only moves when the test says so. Nothing in it touches real time. */
export function makeFakeClock(start = Date.parse("2026-11-25T00:00:00.000Z")): FakeClock {
  let now = start;
  let seq = 0;
  const timers: Timer[] = [];

  const add = (ms: number, fire: () => void): Timer => {
    const t = { at: now + Math.max(0, ms), seq: seq++, fire };
    timers.push(t);
    return t;
  };
  const remove = (t: Timer): void => {
    const i = timers.indexOf(t);
    if (i >= 0) timers.splice(i, 1);
  };
  const earliest = (): Timer | undefined =>
    timers.reduce<Timer | undefined>(
      (a, t) => (!a || t.at < a.at || (t.at === a.at && t.seq < a.seq) ? t : a),
      undefined,
    );

  const advance = (ms: number): void => {
    if (!(ms >= 0)) throw new RangeError(`advance needs a non-negative number, got ${ms}`);
    const target = now + ms;
    for (let t = earliest(); t && t.at <= target; t = earliest()) {
      remove(t);
      now = t.at;
      t.fire();
    }
    now = target;
  };

  return {
    now: () => now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const t = add(ms, () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
        const onAbort = (): void => {
          remove(t);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    timeout: (ms) => {
      const c = new AbortController();
      add(ms, () => c.abort(new DOMException("The operation timed out.", "TimeoutError")));
      return c.signal;
    },
    advance,
    next: () => {
      const t = earliest();
      if (!t) return false;
      advance(t.at - now);
      return true;
    },
    pending: () => timers.length,
  };
}
