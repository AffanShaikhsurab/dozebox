// C4: SNS-in and runner alerts -> policy (core routeAlert) -> outbox -> sinks, with the sink breaker.
import type { Breaker } from "@dozebox/core/alerts";
import type { Alert, AlertSink } from "../ports/alertSink.ts";
import type { Outbox } from "./outbox.ts";

export type AlertPathVerdict = { readonly level: "ok" | "warn" | "fail"; readonly why: string };

export type RouterDeps = {
  readonly sinks: ReadonlyArray<AlertSink>;
  readonly outbox: Outbox;
  readonly clock: { readonly now: () => number };
  /** Per-sink breaker state, read and written inside the tick's lease. */
  readonly breakers: {
    readonly read: () => Promise<Readonly<Record<string, Breaker>>>;
    readonly write: (b: Readonly<Record<string, Breaker>>, token: number) => Promise<void>;
  };
};

export interface AlertRouter {
  /** Admit through the alert policy and enqueue for every sink that accepts the severity. */
  readonly submit: (alert: Alert, token: number) => Promise<void>;
  /** Deliver what is due (called by every tick and right after submit). Returns how many were sent. */
  readonly drain: (signal: AbortSignal, token: number) => Promise<number>;
  /** Email via SNS is the last sink and is never skipped; any open breaker makes the verdict `warn`. */
  readonly pathVerdict: () => Promise<AlertPathVerdict>;
}

export function makeAlertRouter(_deps: RouterDeps): AlertRouter {
  throw new Error("not implemented: C4 makeAlertRouter");
}
