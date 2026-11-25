// The agent's periodic loops. Each loop runs its tick, records a beat, and sleeps; one bad tick never kills the
// process (part 6 §6.7): an operational error (RunnerError) is logged and kept for last words; a bug (any other
// error) is logged with its stack, and three bugs in a row from one loop end the process (systemd restarts it).
import { RunnerError } from "@dozebox/core/errors";
import type { LoopBeat } from "@dozebox/core/health";
import type { Clock } from "@dozebox/core/time";
import type { ErrorLog } from "./errors.ts";
import type { Logger } from "./ports/log.ts";

export type Loop = {
  readonly name: string;
  readonly everyMs: number;
  /** Run the first tick at start instead of after the first interval. */
  readonly immediate?: boolean;
  /** A tick that ignores `signal` delays stop by up to STOP_GRACE_MS. */
  readonly tick: (signal: AbortSignal) => Promise<void>;
};

export type LoopsDeps = {
  readonly clock: Clock;
  readonly log: Logger;
  readonly errors: ErrorLog;
  /** Called once when a loop hits BUGS_IN_A_ROW; the caller stops the loops and exits non-zero. */
  readonly onFatal: (reason: string) => void;
};

export interface RunningLoops {
  /** Every loop's last finished tick (start time before the first), with the age after which it counts as stuck. */
  readonly beats: () => ReadonlyArray<LoopBeat>;
  /** Abort every loop and wait for running ticks (at most STOP_GRACE_MS). Safe to call twice. */
  readonly stop: () => Promise<void>;
}

export const BUGS_IN_A_ROW = 3;
export const STOP_GRACE_MS = 10_000;

/** How long a loop may go without a finished tick before the watchdog treats it as stuck. */
export const stuckAfterMs = (everyMs: number): number => 2 * everyMs + 60_000;

export function runLoops(deps: LoopsDeps, loops: ReadonlyArray<Loop>): RunningLoops {
  const names = loops.map((l) => l.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) throw new Error(`two loops are named "${dup}"`);
  const ctl = new AbortController();
  const started = deps.clock.now();
  const beats = new Map(loops.map((l) => [l.name, started]));
  let fatal = false;

  const runOne = async (loop: Loop): Promise<void> => {
    const log = deps.log.child({ component: loop.name });
    let bugs = 0;
    let wait = loop.immediate ? 0 : loop.everyMs;
    for (;;) {
      try {
        if (wait > 0) await deps.clock.sleep(wait, ctl.signal);
      } catch {
        return; // aborted: stopping
      }
      if (ctl.signal.aborted) return;
      wait = loop.everyMs;
      try {
        await loop.tick(ctl.signal);
        beats.set(loop.name, deps.clock.now());
        bugs = 0;
      } catch (e) {
        if (ctl.signal.aborted) return;
        deps.errors.add(loop.name, e);
        if (e instanceof RunnerError) {
          log.log("warn", "tick failed", { error: e });
          continue;
        }
        bugs++;
        log.log("error", "bug in tick", { error: e, bugsInARow: bugs });
        if (bugs >= BUGS_IN_A_ROW && !fatal) {
          fatal = true;
          deps.onFatal(`${loop.name}: ${BUGS_IN_A_ROW} bugs in a row`);
          return;
        }
      }
    }
  };

  const running = Promise.all(loops.map(runOne));
  let stopping: Promise<void> | null = null;

  return {
    beats: () =>
      loops.map((l) => ({ name: l.name, at: beats.get(l.name) ?? started, expectEveryMs: stuckAfterMs(l.everyMs) })),
    stop: () => {
      stopping ??= (async () => {
        ctl.abort();
        const grace = new AbortController();
        await Promise.race([
          running.then(() => grace.abort()),
          deps.clock.sleep(STOP_GRACE_MS, grace.signal).catch(() => {}),
        ]);
      })();
      return stopping;
    },
  };
}
