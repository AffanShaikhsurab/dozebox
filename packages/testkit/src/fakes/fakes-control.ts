// Fakes for the control lane's plugin points (C4, C5): an alert sink that records, an in-memory secret reader, and a
// wake source driven by a table. Other lanes (docs, drills, the simulator) test against these.
import type { Alert, AlertSeverity, AlertSink, DeliveryResult } from "@dozebox/control/ports/alertSink";
import type { SecretReader } from "@dozebox/control/ports/sharedSecrets";
import type { BoxWakes, HookRequest, WakeMatch, WakeSource } from "@dozebox/control/ports/wakeSource";

export type FakeAlertSink = AlertSink & {
  readonly delivered: ReadonlyArray<Alert>;
  /** The next results to return, in order; empty means `{ ok: true }`. */
  readonly script: (results: ReadonlyArray<DeliveryResult>) => void;
};

export function makeFakeAlertSink(
  id = "fake",
  accepts: ReadonlyArray<AlertSeverity> = ["page", "notify", "info"],
): FakeAlertSink {
  const delivered: Alert[] = [];
  const queue: DeliveryResult[] = [];
  return {
    id,
    accepts: (s) => accepts.includes(s),
    deliver: async (alert) => {
      const next = queue.shift() ?? { ok: true, receiptExpected: false };
      if (next.ok) delivered.push(alert);
      return next;
    },
    delivered,
    script: (results) => void queue.push(...results),
  };
}

export function makeFakeSecretReader(values: Readonly<Record<string, string>> = {}): SecretReader & {
  readonly set: (name: string, value: string | null) => void;
} {
  const store = new Map(Object.entries(values));
  return {
    get: async (name) => store.get(name) ?? null,
    set: (name, value) => void (value === null ? store.delete(name) : store.set(name, value)),
  };
}

/** A wake source whose signature check is `x-fake-signature: ok` and whose matcher is the given function. */
export function makeFakeWakeSource(
  match: (req: HookRequest, wakes: BoxWakes, now: number) => WakeMatch = () => ({ wake: false, why: "fake" }),
  id = "fake",
): WakeSource {
  return {
    id,
    route: { method: "POST", path: `/v1/hooks/${id}` },
    verify: async (req) => req.headers["x-fake-signature"] === "ok",
    match,
  };
}
