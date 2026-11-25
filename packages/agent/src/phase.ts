// The agent's phase machine (part 6 §6.3): a discriminated union with an exhaustive switch. Owned by agent-core (A5).
import type { ParkReason } from "@dozebox/protocol/records";

export type { ParkReason };

export type AgentPhase =
  | { readonly phase: "booting"; readonly since: number }
  | { readonly phase: "serving"; readonly since: number }
  | { readonly phase: "idle-pending"; readonly since: number; readonly sleepAt: number }
  | { readonly phase: "reclaim-notice"; readonly since: number; readonly terminationAt: number }
  | { readonly phase: "sleeping"; readonly since: number; readonly reason: ParkReason }
  | { readonly phase: "frozen"; readonly since: number };

/** False once a park or a reclaim is under way: a second park never starts. */
export function canPark(p: AgentPhase): boolean {
  switch (p.phase) {
    case "booting":
    case "serving":
    case "idle-pending":
    case "frozen":
      return true;
    case "reclaim-notice":
    case "sleeping":
      return false;
    default: {
      const never: never = p;
      return never;
    }
  }
}

/** The current phase, shared by the loops. `onChange` mirrors it to `/run/dozebox/phase` for the failsafe. */
export interface PhaseCell {
  readonly get: () => AgentPhase;
  readonly set: (next: AgentPhase) => void;
}

export function makePhaseCell(first: AgentPhase, onChange: (p: AgentPhase) => void = () => {}): PhaseCell {
  let current = first;
  return {
    get: () => current,
    set: (next) => {
      const changed = next.phase !== current.phase;
      current = next;
      if (changed) onChange(next);
    },
  };
}
