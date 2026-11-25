// C2: the reconcile lease with a fencing token, on top of StateTable (part 6 §6.3 "Lease with a fencing token").
import type { Clock } from "@dozebox/core/time";
import type { Lease, StateTable } from "../ports/state.ts";

/** Today's value: a tick holds the reconcile lease for 45 s. */
export const LEASE_TTL_MS = 45_000;
/** A tick stops starting new steps when less lease than this is left. */
export const LEASE_MIN_LEFT_MS = 10_000;

export interface HeldLease {
  readonly lease: Lease;
  /** Milliseconds of lease left at `now`, never negative. */
  readonly remainingMs: (now: number) => number;
  /** True while at least LEASE_MIN_LEFT_MS is left. */
  readonly mayContinue: (now: number) => boolean;
  /** Every state write inside a tick: refused with RunnerError `lease_lost` when a newer token wrote first. */
  readonly putFenced: (key: string, value: unknown) => Promise<void>;
}

export type LeaseKeeperDeps = {
  readonly state: StateTable;
  readonly clock: Pick<Clock, "now">;
  /** This invocation, such as the Lambda request id. */
  readonly holder: string;
};

export interface LeaseKeeper {
  /** The lease `name`, or null when another holder has it (the caller counts `ReconcileSkipped`). */
  readonly acquire: (name: string, ttlMs?: number) => Promise<HeldLease | null>;
}

export function makeLeaseKeeper(_deps: LeaseKeeperDeps): LeaseKeeper {
  throw new Error("not implemented: C2 makeLeaseKeeper");
}
