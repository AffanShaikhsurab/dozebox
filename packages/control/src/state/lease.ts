// C2: the reconcile lease with a fencing token, on top of StateTable (part 6 §6.3 "Lease with a fencing token").
// The table grants the lease with one conditional update and a token that grows on every grant; every state write a
// tick makes goes through `putFenced`, which the table refuses once a newer token wrote the key. A tick also refuses
// its own writes once its lease ran out locally, so a paused tick stops writing even to keys no newer tick touched.
import { RunnerError } from "@dozebox/core/errors";
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

export function makeLeaseKeeper(deps: LeaseKeeperDeps): LeaseKeeper {
  return {
    acquire: async (name, ttlMs = LEASE_TTL_MS) => {
      const lease = await deps.state.acquireLease(name, deps.holder, ttlMs, deps.clock.now());
      if (lease === null) return null;
      const remainingMs = (now: number): number => Math.max(0, lease.expiresAt - now);
      return {
        lease,
        remainingMs,
        mayContinue: (now) => remainingMs(now) >= LEASE_MIN_LEFT_MS,
        putFenced: async (key, value) => {
          if (remainingMs(deps.clock.now()) === 0) {
            throw new RunnerError("lease_lost", false, `lease ${name} expired before writing ${key}`);
          }
          await deps.state.putFenced(key, value, lease.token);
        },
      };
    },
  };
}
