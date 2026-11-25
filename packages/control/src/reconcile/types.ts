// C3: the types observe and act share. TickDeps is the part of C1's `Deps` the tick reads.
import type { Action, Desired, Observed } from "@dozebox/core/reconcile";
import type { Deps } from "../deps.ts";
import type { StatusFacts } from "../status/build.ts";

export type TickDeps = Pick<
  Deps,
  "config" | "clock" | "compute" | "records" | "state" | "desired" | "volumes" | "leases" | "log" | "metrics"
>;

export type Snapshot = {
  readonly desired: Desired;
  readonly observed: Observed;
  /** The facts the snapshot was built from (status and caps read them too). */
  readonly facts: StatusFacts;
  /** The group raise-fallback and lower-fallback act on (the fallback group, else the Spot group). */
  readonly groupName: string | null;
};

export type ActOutcome =
  | { readonly kind: "acted"; readonly action: Action["kind"]; readonly token: string }
  | { readonly kind: "skipped"; readonly action: Action["kind"]; readonly why: string }
  | { readonly kind: "idle"; readonly why: string };
