// A5: every 30 s, core idleVerdict over the holds, presence and health-only activity; idle past `idleMs` parks.
// Returns an A1 `Loop` for `runLoops`, like `watchdogLoop`. Only a serving box parks for idle: a box that never served
// is the failsafe's job (part 6 §6.3), and a box already parking or reclaimed is left alone. An idle verdict is
// confirmed once more after IDLE_CONFIRM_MS (part 4 §4.16: anything new in that window cancels the park).
import { idleVerdict, type IdleVerdict } from "@dozebox/core/idle";
import { toInstant, type Clock } from "@dozebox/core/time";
import type { Loop } from "../loops.ts";
import type { AgentPhase, ParkReason } from "../phase.ts";
import type { HoldSource } from "../ports/holds.ts";

export const IDLE_LOOP = "idle";
export const IDLE_LOOP_MS = 30_000;
export const IDLE_CONFIRM_MS = 10_000;

export type IdleLoopDeps = {
  readonly clock: Pick<Clock, "now" | "sleep">;
  readonly holds: HoldSource;
  readonly idleMs: () => number;
  readonly viewingGraceMs: () => number;
  readonly servingSince: () => number | null;
  /** Health-only fallback (cgroup cpu.stat), epoch ms, or null. */
  readonly lastActivityAt: () => Promise<number | null>;
  readonly phase: () => AgentPhase;
  /** Each verdict, for the phase (`idle-pending`) and liveness. */
  readonly onVerdict?: (v: IdleVerdict) => void;
  readonly park: (reason: ParkReason, detail: string) => Promise<unknown>;
};

const watching = (p: AgentPhase): boolean => p.phase === "serving" || p.phase === "idle-pending";

export function idleLoop(deps: IdleLoopDeps): Loop {
  const evaluate = async (): Promise<IdleVerdict> => {
    const now = deps.clock.now();
    const [holds, presence, lastProgressAt, lastInteractiveAt, lastActivityAt] = await Promise.all([
      deps.holds.holds(now),
      deps.holds.presence(now),
      deps.holds.lastProgressAt(),
      deps.holds.lastInteractiveAt(),
      deps.lastActivityAt(),
    ]);
    const v = idleVerdict({
      now,
      idleMs: deps.idleMs(),
      viewingGraceMs: deps.viewingGraceMs(),
      servingSince: deps.servingSince(),
      holds,
      presence,
      lastInteractiveAt,
      lastProgressAt,
      lastActivityAt,
    });
    deps.onVerdict?.(v);
    return v;
  };

  return {
    name: IDLE_LOOP,
    everyMs: IDLE_LOOP_MS,
    tick: async (signal) => {
      if (!watching(deps.phase())) return;
      if ((await evaluate()).kind !== "idle") return;
      await deps.clock.sleep(IDLE_CONFIRM_MS, signal);
      if (!watching(deps.phase())) return;
      const v = await evaluate();
      if (v.kind !== "idle") return;
      const minutes = Math.round((deps.clock.now() - v.since) / 60_000);
      await deps.park("idle", `idle for ${minutes} min (last activity ${toInstant(v.since)})`);
    },
  };
}
