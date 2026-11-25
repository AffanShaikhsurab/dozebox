// C3: execute one Action. Destructive and billing actions re-read EC2, the fence and the intent first and skip when
// any changed (fence appeared, desired flipped, instance state moved). Tokens come from the intent id (actionToken).
import type { Action } from "@dozebox/core/reconcile";
import type { HeldLease } from "../state/index.ts";
import type { ActOutcome, Snapshot, TickDeps } from "./types.ts";

export function act(
  _deps: TickDeps,
  _action: Action,
  _ctx: { readonly lease: HeldLease; readonly snapshot: Snapshot },
): Promise<ActOutcome> {
  throw new Error("not implemented: C3 act");
}
