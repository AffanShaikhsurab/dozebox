// A7: attention and runner alerts -> SNS with redaction; what cannot be sent waits in an undelivered queue that
// `rec/liveness` carries (bounded), and is retried every minute.
import type { AttentionInput } from "@dozebox/protocol/v1";
import type { BoxNotifier } from "../ports/notify.ts";

export type BoxAlert = {
  readonly id: string;
  readonly source: string;
  readonly severity: AttentionInput["severity"];
  readonly title: string;
  readonly body: string;
  readonly at: number;
};

/** Pure: replace tokens, keys, ARNs, account ids and e-mail addresses with `[redacted]`. */
export function redact(_text: string): string {
  throw new Error("not implemented: A7 redact");
}

export interface AlertForwarder {
  /** Returns the alert id. Never throws for a send failure: the alert waits in the queue. */
  readonly forward: (alert: Omit<BoxAlert, "id" | "at">) => Promise<string>;
  readonly retry: (signal: AbortSignal) => Promise<number>;
  readonly undelivered: () => ReadonlyArray<BoxAlert>;
}

export function makeAlertForwarder(_deps: {
  readonly notifier: BoxNotifier;
  readonly now: () => number;
  readonly ids: () => string;
  readonly queueLimit?: number;
}): AlertForwarder {
  throw new Error("not implemented: A7 makeAlertForwarder");
}
