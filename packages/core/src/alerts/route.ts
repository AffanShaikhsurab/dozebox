// Alert routing policy (part 6 §6.3, legacy alert router): which sinks get an admitted alert now, and which pages go to
// email later. Phone sinks (ntfy, web push, webhook) get pages and notices. Email is the last sink: it is never skipped
// by its breaker, gets a page at once when no phone sink can take it, and otherwise only the pages that no phone
// confirmed within 10 minutes. `info` is never pushed; the summary shows it.
import { allow, type Breaker } from "./breaker.ts";
import { ESCALATE_AFTER_MS, type Pending } from "./ledger.ts";

export type SinkState = {
  readonly name: string;
  /** Email via the alert topic: the sink of last resort. */
  readonly lastResort: boolean;
  readonly breaker: Breaker;
};

export type Route = {
  /** Sinks to deliver through now, each with the breaker to record the result on (half-open is one try). */
  readonly deliver: ReadonlyArray<{ readonly sink: string; readonly breaker: Breaker }>;
  /** Sinks skipped by an open breaker. */
  readonly skipped: ReadonlyArray<string>;
  /** `warn` while any sink is skipped, or when a notice has no phone sink to go to. */
  readonly pathLevel: "ok" | "warn";
};

export function routeAlert(severity: "page" | "notify" | "info", sinks: ReadonlyArray<SinkState>, now: number): Route {
  const skipped: string[] = [];
  const phones: Array<{ sink: string; breaker: Breaker }> = [];
  for (const s of sinks) {
    if (s.lastResort) continue;
    const b = allow(s.breaker, now);
    if (b === null) skipped.push(s.name);
    else phones.push({ sink: s.name, breaker: b });
  }
  const level = skipped.length > 0 ? "warn" : "ok";
  if (severity === "info") return { deliver: [], skipped, pathLevel: level };
  const email = sinks.find((s) => s.lastResort);
  if (phones.length > 0) return { deliver: phones, skipped, pathLevel: level };
  if (severity === "page" && email !== undefined) {
    return { deliver: [{ sink: email.name, breaker: email.breaker }], skipped, pathLevel: level };
  }
  return { deliver: [], skipped, pathLevel: "warn" };
}

/** Pages to send to email now: pending longer than 10 minutes with no phone receipt. */
export function escalationsDue(
  pending: ReadonlyArray<Pending>,
  confirmed: ReadonlySet<string>,
  now: number,
  afterMs = ESCALATE_AFTER_MS,
): Pending[] {
  return pending.filter((p) => !confirmed.has(p.key) && now - p.at >= afterMs);
}
