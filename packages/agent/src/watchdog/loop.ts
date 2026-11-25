// The systemd watchdog ping (part 6 §6.3 "Dead man's switches"): `WATCHDOG=1` only at the end of a tick that found
// every other loop alive, never from a bare timer, so a wedged loop or event loop gets the agent killed and
// restarted. Runs at half of WatchdogSec (env.ts). Health strikes join this loop with A5.
import { RunnerError } from "@dozebox/core/errors";
import { missedLoops, type LoopBeat } from "@dozebox/core/health";
import type { Clock } from "@dozebox/core/time";
import type { Loop } from "../loops.ts";
import type { Systemd } from "../ports/systemd.ts";

export const WATCHDOG_LOOP = "watchdog";

export function watchdogLoop(deps: {
  readonly everyMs: number;
  readonly clock: Pick<Clock, "now">;
  readonly systemd: Systemd;
  /** The other loops' beats; the watchdog's own is left out. */
  readonly beats: () => ReadonlyArray<LoopBeat>;
}): Loop {
  return {
    name: WATCHDOG_LOOP,
    everyMs: deps.everyMs,
    tick: async () => {
      const stuck = missedLoops(
        deps.beats().filter((b) => b.name !== WATCHDOG_LOOP),
        deps.clock.now(),
      );
      if (stuck.length > 0) {
        // Not a bug and not retried: systemd's watchdog ends the process when the pings stop.
        throw new RunnerError("internal", false, `no WATCHDOG=1: loops stuck: ${stuck.join(", ")}`);
      }
      await deps.systemd.notify("WATCHDOG=1");
    },
  };
}
