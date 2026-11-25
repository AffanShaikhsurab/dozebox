// C6: the outside judge, run by every tick inside the lease: wake failure (R3: a wake that does not serve in time),
// silent box (liveness older than the alert gap), no-progress park from generic liveness (core decideNoProgress).
// It owns the `wake-breaker` key of C1's `state/keys.ts` and writes desired = asleep with origin `judge`.
import type { Desired } from "@dozebox/core/reconcile";
import type { WakeBreaker } from "@dozebox/core/wake";
import type { AlertRouter } from "../alerts/index.ts";
import type { RecordStore } from "../ports/records.ts";

export type JudgeVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "wake-unresolved"; readonly sinceMs: number }
  | { readonly kind: "silent"; readonly lastSeenAt: number | null }
  | { readonly kind: "no-progress-park"; readonly idleForMs: number };

export type JudgeDeps = {
  readonly clock: { readonly now: () => number };
  readonly records: RecordStore;
  /** C1's DesiredStore satisfies it. */
  readonly desired: {
    readonly read: () => Promise<Desired>;
    readonly write: (d: Desired) => Promise<"written" | "older">;
  };
  readonly breaker: {
    readonly read: () => Promise<WakeBreaker | null>;
    readonly write: (b: WakeBreaker, token: number) => Promise<void>;
  };
  readonly alerts: Pick<AlertRouter, "submit">;
  readonly noProgressParkMs: number;
};

export interface OutsideJudge {
  /** Judge once; pages and parks when the verdict says so. */
  readonly run: (token: number) => Promise<JudgeVerdict>;
}

export function makeOutsideJudge(_deps: JudgeDeps): OutsideJudge {
  throw new Error("not implemented: C6 makeOutsideJudge");
}
