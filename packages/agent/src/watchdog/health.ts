// A5: the health loop (part 4 §4.12, part 6 §6.3). Every `health.checkEverySeconds`: run each payload's check, read
// the unit states, and let core's decideHealth say what to do: the first healthy check marks the boot as serving,
// unhealthy checks count strikes (restart at 5 and 10, park at 15, at most 2 restarts an hour), a unit in
// `ActiveState=failed` (systemd's start limit) parks at once. The pure decision lives in core; this is the shell.
import { decideHealth, HEALTH_DEFAULTS, NEW_HEALTH_STATE, type HealthConfig } from "@dozebox/core/health";
import type { Clock } from "@dozebox/core/time";
import type { Loop } from "../loops.ts";
import type { ParkReason, PhaseCell } from "../phase.ts";
import type { Logger } from "../ports/log.ts";
import type { HealthResult, PayloadSupervisor } from "../ports/payloads.ts";

export const HEALTH_LOOP = "health";

export type HealthLoopDeps = {
  readonly clock: Pick<Clock, "now">;
  readonly log: Logger;
  readonly payloads: Pick<PayloadSupervisor, "checkHealth" | "states" | "restart">;
  readonly everyMs: number;
  readonly config: () => Pick<HealthConfig, "restartAtStrikes" | "parkAtStrikes" | "restartsPerHour">;
  readonly phase: PhaseCell;
  /** Network reachability (A6); up when absent. */
  readonly netUp?: () => boolean;
  /** Payload loop beats past their deadline (A2); none when absent. */
  readonly missedLoops?: () => ReadonlyArray<string>;
  /** The first healthy check of this boot: `rec/serving` and its side effects. */
  readonly onServing: (payload: string) => Promise<void>;
  readonly park: (reason: ParkReason, detail: string) => Promise<unknown>;
};

export interface HealthLoop extends Loop {
  readonly strikes: () => number;
  readonly servingSince: () => number | null;
  /** Whether `name` passed its last check (false before the first). */
  readonly healthy: (name: string) => boolean;
}

const skip = new Set(["sleeping", "reclaim-notice"]);

export function healthLoop(deps: HealthLoopDeps): HealthLoop {
  const log = deps.log.child({ component: HEALTH_LOOP });
  let state = NEW_HEALTH_STATE;
  let servingSince: number | null = null;
  let last: ReadonlyArray<HealthResult> = [];

  const tick = async (signal: AbortSignal): Promise<void> => {
    if (skip.has(deps.phase.get().phase)) return;
    const results = await deps.payloads.checkHealth(signal);
    const units = await deps.payloads.states();
    last = results;
    const failed = units.filter((u) => u.active === "failed").map((u) => u.name);
    const sick = results.filter((r) => !r.ok);
    const now = deps.clock.now();
    const d = decideHealth(state, {
      now,
      served: servingSince !== null,
      healthy: sick.length === 0,
      missedLoops: deps.missedLoops?.() ?? [],
      netUp: deps.netUp?.() ?? true,
      unitFailed: failed.length > 0,
      config: { ...HEALTH_DEFAULTS, ...deps.config() },
    });
    state = d.state;
    if (d.netBack) log.log("info", "network back");
    const a = d.action;
    switch (a.kind) {
      case "serving": {
        servingSince = now;
        if (deps.phase.get().phase === "booting") deps.phase.set({ phase: "serving", since: now });
        log.log("info", "serving");
        await deps.onServing(results[0]?.name ?? units[0]?.name ?? "");
        return;
      }
      case "restart": {
        log.log("warn", "restarting unhealthy payloads", { strikes: a.strikes, restart: a.restart, cause: a.cause });
        for (const r of sick) await deps.payloads.restart(r.name, signal);
        return;
      }
      case "park": {
        const why =
          a.reason === "unit-failed"
            ? `payload unit failed: ${failed.join(", ")}`
            : `unhealthy after ${a.strikes} checks (${a.restarts} restarts this hour): ${sick.map((r) => `${r.name}: ${r.detail}`).join("; ")}`;
        await deps.park("unhealthy", why);
        return;
      }
      case "count":
        log.log("warn", "unhealthy", { strikes: a.strikes, cause: a.cause, detail: sick.map((r) => r.detail) });
        return;
      case "net-down":
        log.log("warn", "network down: strikes paused");
        return;
      case "hold":
      case "ok":
      case "not-serving":
        return;
      default: {
        const never: never = a;
        return never;
      }
    }
  };

  return {
    name: HEALTH_LOOP,
    everyMs: deps.everyMs,
    immediate: true,
    tick,
    strikes: () => state.strikes,
    servingSince: () => servingSince,
    healthy: (name) => last.some((r) => r.name === name && r.ok),
  };
}
