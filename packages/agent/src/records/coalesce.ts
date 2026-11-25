// A7: coalescing in front of A1's RecordPublisher: `rec/liveness` within 10 s of a change and at least every 5 min;
// one write in flight per record; throttled writes back off (full jitter) without losing the newest body.
import { RunnerError } from "@dozebox/core/errors";
import type { RecordName, RecordTypes } from "@dozebox/core/records";
import type { Clock } from "@dozebox/core/time";
import type { RecordPublisher } from "./publish.ts";

export const LIVENESS_CHANGE_MS = 10_000;
export const LIVENESS_EVERY_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export interface CoalescingPublisher {
  /** Remember the newest body for `name`; it is written within `LIVENESS_CHANGE_MS` when it differs. */
  readonly offer: <N extends RecordName>(name: N, body: Omit<RecordTypes[N], "v" | "at" | "writer">) => void;
  /** Write everything pending now (park calls it before last words). */
  readonly flush: (signal: AbortSignal) => Promise<void>;
}

type Body = { readonly text: string; readonly value: unknown };

type Slot = {
  readonly name: RecordName;
  last: Body | null;
  pending: Body | null;
  pendingSince: number;
  inflight: Body | null;
  run: Promise<void> | null;
  timer: AbortController | null;
  keep: AbortController | null;
  failures: number;
};

export function makeCoalescingPublisher(deps: {
  readonly publisher: RecordPublisher;
  readonly clock: Clock;
  readonly rand: () => number;
}): CoalescingPublisher {
  const slots = new Map<RecordName, Slot>();

  const after = (ms: number, fn: () => void): AbortController => {
    const ctl = new AbortController();
    deps.clock.sleep(ms, ctl.signal).then(fn, () => {});
    return ctl;
  };

  const arm = (s: Slot, ms: number): void => {
    if (s.timer) return;
    const ctl = after(Math.max(0, ms), () => {
      s.timer = null;
      void drain(s);
    });
    s.timer = ctl;
  };

  const armKeep = (s: Slot): void => {
    s.keep?.abort();
    s.keep = null;
    if (s.name !== "rec/liveness") return;
    s.keep = after(LIVENESS_EVERY_MS, () => {
      s.keep = null;
      if (s.pending || s.run || !s.last) return;
      s.pending = s.last;
      s.pendingSince = deps.clock.now();
      void drain(s);
    });
  };

  const run = async (s: Slot): Promise<void> => {
    const body = s.pending;
    if (!body) return;
    s.pending = null;
    s.inflight = body;
    try {
      await deps.publisher.put(s.name, body.value as never);
      s.last = body;
      s.failures = 0;
      armKeep(s);
    } catch (e) {
      if (e instanceof RunnerError && e.retryable) {
        s.pending ??= body;
        const wait = deps.rand() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** s.failures);
        s.failures++;
        s.timer?.abort();
        s.timer = null;
        arm(s, wait);
        return;
      }
      s.failures = 0;
      armKeep(s);
    } finally {
      s.inflight = null;
    }
    if (s.pending) arm(s, s.pendingSince + LIVENESS_CHANGE_MS - deps.clock.now());
  };

  function drain(s: Slot): Promise<void> {
    s.run ??= run(s).finally(() => {
      s.run = null;
    });
    return s.run;
  }

  const slotFor = (name: RecordName): Slot => {
    let s = slots.get(name);
    if (!s) {
      s = {
        name,
        last: null,
        pending: null,
        pendingSince: 0,
        inflight: null,
        run: null,
        timer: null,
        keep: null,
        failures: 0,
      };
      slots.set(name, s);
    }
    return s;
  };

  return {
    offer: (name, value) => {
      const s = slotFor(name);
      const text = JSON.stringify(value);
      if (text === (s.inflight ?? s.last)?.text) {
        s.pending = null;
        return;
      }
      if (!s.pending) s.pendingSince = deps.clock.now();
      s.pending = { text, value };
      if (!s.run) arm(s, LIVENESS_CHANGE_MS);
    },
    flush: async (signal) => {
      for (const s of slots.values()) {
        signal.throwIfAborted();
        s.timer?.abort();
        s.timer = null;
        if (s.run) await s.run;
        if (s.pending) await drain(s);
      }
    },
  };
}
