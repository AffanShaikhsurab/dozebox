// C3: the types observe and act share. `tick(deps: Deps, ctx: TickContext): Promise<void>` itself stays in C1's
// `reconcile/tick.ts` (C3 fills its body). TickDeps is the part of C1's `Deps` observe and act read, plus what C2
// and C3 add to `Deps` (`volumes`, `leases`).
import type { Action, Desired, Observed } from "@dozebox/core/reconcile";
import type { Compute } from "../ports/compute.ts";
import type { RecordStore } from "../ports/records.ts";
import type { StateTable } from "../ports/state.ts";
import type { Volumes } from "../ports/volumes.ts";
import type { LeaseKeeper } from "../state/index.ts";

export type TickDeps = {
  readonly config: {
    readonly box: { readonly id: string };
    readonly groups: { readonly spot: string | null; readonly fallback: string | null };
  };
  readonly clock: { readonly now: () => number };
  readonly compute: Compute;
  readonly records: RecordStore;
  readonly state: StateTable;
  readonly desired: { readonly read: () => Promise<Desired> };
  /** Added to C1's Deps by C3 (C1's AwsPorts has no volumes port yet). */
  readonly volumes: Volumes;
  /** Added to C1's Deps by C2. */
  readonly leases: LeaseKeeper;
};

export type Snapshot = {
  readonly desired: Desired;
  readonly observed: Observed;
};

export type ActOutcome =
  | { readonly kind: "acted"; readonly action: Action["kind"]; readonly token: string }
  | { readonly kind: "skipped"; readonly action: Action["kind"]; readonly why: string }
  | { readonly kind: "idle"; readonly why: string };
