// The real clock: wall time, timers and timeouts. The only place in the agent that reads Date.now or setTimeout.
import { setTimeout as delay } from "node:timers/promises";
import type { Clock } from "@dozebox/core/time";

export function makeSystemClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms, signal) => delay(ms, undefined, signal ? { signal } : {}),
    timeout: (ms) => AbortSignal.timeout(ms),
  };
}
