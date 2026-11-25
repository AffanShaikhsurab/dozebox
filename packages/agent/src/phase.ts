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
export function canPark(_p: AgentPhase): boolean {
  throw new Error("not implemented: A5 canPark");
}
