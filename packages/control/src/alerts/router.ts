// C4: runner alerts -> policy (core admitAlert, routeAlert) -> outbox -> sinks, with the sink breaker.
// submit only enqueues (one outbox item per chosen sink, written before any delivery); drain delivers what is due,
// records each result on the sink's breaker and marks the item, so a crash anywhere re-delivers on the next tick.
// Email (SNS) is the last sink: never skipped by its breaker, and only used when no phone sink can take a page.
import { admitAlert, allow, CLOSED, onResult, routeAlert, type Breaker, type Ledger } from "@dozebox/core/alerts";
import type { Alert, AlertSink } from "../ports/alertSink.ts";
import type { Outbox } from "./outbox.ts";

export type AlertPathVerdict = { readonly level: "ok" | "warn" | "fail"; readonly why: string };

const LAST_RESORT = "email";

export type RouterDeps = {
  readonly sinks: ReadonlyArray<AlertSink>;
  readonly outbox: Outbox;
  readonly clock: { readonly now: () => number };
  /** Per-sink breaker state, read and written inside the tick's lease. */
  readonly breakers: {
    readonly read: () => Promise<Readonly<Record<string, Breaker>>>;
    readonly write: (b: Readonly<Record<string, Breaker>>, token: number) => Promise<void>;
  };
  /** The admission ledger (dedupe per key, notice rate limits, page ceiling). */
  readonly ledger: {
    readonly read: () => Promise<Ledger>;
    readonly write: (l: Ledger, token: number) => Promise<void>;
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

export function makeAlertRouter(deps: RouterDeps): AlertRouter {
  const byId = new Map(deps.sinks.map((s) => [s.id, s]));
  const breakerOf = (all: Readonly<Record<string, Breaker>>, id: string): Breaker => all[id] ?? CLOSED;

  return {
    submit: async (alert, token) => {
      const now = deps.clock.now();
      const admission = admitAlert(await deps.ledger.read(), { key: alert.key, severity: alert.severity, text: alert.title }, now);
      if (admission.send) {
        const breakers = await deps.breakers.read();
        const states = deps.sinks
          .filter((s) => s.accepts(alert.severity))
          .map((s) => ({ name: s.id, lastResort: s.id === LAST_RESORT, breaker: breakerOf(breakers, s.id) }));
        const route = routeAlert(alert.severity, states, now);
        await deps.outbox.enqueue(
          alert,
          route.deliver.map((d) => d.sink),
          token,
        );
      }
      await deps.ledger.write(admission.ledger, token);
    },

    drain: async (signal, token) => {
      const now = deps.clock.now();
      const breakers: Record<string, Breaker> = { ...(await deps.breakers.read()) };
      let sent = 0;
      for (const item of await deps.outbox.due(now)) {
        if (signal.aborted) break;
        const sink = byId.get(item.sink);
        if (sink === undefined) {
          await deps.outbox.markAttempt(item, "unknown sink", token);
          continue;
        }
        const current = breakerOf(breakers, sink.id);
        const through = sink.id === LAST_RESORT ? current : allow(current, now);
        if (through === null) continue; // open breaker: stays pending, costs no attempt
        const result = await sink.deliver(item.alert, signal);
        breakers[sink.id] = onResult(through, result.ok, now);
        if (result.ok) {
          await deps.outbox.markSent(item, token);
          sent += 1;
        } else {
          await deps.outbox.markAttempt(item, result.reason, token);
        }
      }
      await deps.breakers.write(breakers, token);
      return sent;
    },

    pathVerdict: async () => {
      const breakers = await deps.breakers.read();
      if (!byId.has(LAST_RESORT)) return { level: "fail", why: "no email sink" };
      const phones = deps.sinks.filter((s) => s.id !== LAST_RESORT);
      const now = deps.clock.now();
      const open = phones.filter((s) => allow(breakerOf(breakers, s.id), now) === null).map((s) => s.id);
      if (open.length > 0) return { level: "warn", why: `skipped: ${open.join(", ")}` };
      if (phones.length === 0) return { level: "warn", why: "no phone sink; pages go to email only" };
      return { level: "ok", why: "every sink closed" };
    },
  };
}
