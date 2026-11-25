// A5: every 30 s, core idleVerdict over the holds, presence and health-only activity; idle past `idleMs` parks.
// Returns an A1 `Loop` for `runLoops`, like `watchdogLoop`.
import type { Clock } from "@dozebox/core/time";
import type { Loop } from "../loops.ts";
import type { AgentPhase, ParkReason } from "../phase.ts";
import type { HoldSource } from "../ports/holds.ts";

export const IDLE_LOOP = "idle";
export const IDLE_LOOP_MS = 30_000;

export type IdleLoopDeps = {
  readonly clock: Pick<Clock, "now">;
  readonly holds: HoldSource;
  readonly idleMs: number;
  readonly viewingGraceMs: number;
  readonly servingSince: () => number | null;
  /** Health-only fallback (cgroup cpu.stat), epoch ms, or null. */
  readonly lastActivityAt: () => Promise<number | null>;
  readonly phase: () => AgentPhase;
  readonly park: (reason: ParkReason, detail: string) => Promise<void>;
};

export function idleLoop(_deps: IdleLoopDeps): Loop {
  throw new Error("not implemented: A5 idleLoop");
}
