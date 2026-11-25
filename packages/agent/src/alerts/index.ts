// A7: attention and runner alerts -> SNS with redaction; what cannot be sent waits in an undelivered queue that
// `rec/liveness` carries (bounded), and is retried every minute.
import type { AttentionInput } from "@dozebox/protocol/v1";
import type { BoxNotifier } from "../ports/notify.ts";
import { redact } from "./redact.ts";

export { redact };

export const UNDELIVERED_AFTER_MS = 10 * 60_000;
const SUBJECT_MAX = 100;

export type BoxAlert = {
  readonly id: string;
  readonly source: string;
  readonly severity: AttentionInput["severity"];
  readonly title: string;
  readonly body: string;
  readonly at: number;
};

export interface AlertForwarder {
  /** Returns the alert id. Never throws for a send failure: the alert waits in the queue. */
  readonly forward: (alert: Omit<BoxAlert, "id" | "at">) => Promise<string>;
  readonly retry: (signal: AbortSignal) => Promise<number>;
  readonly undelivered: () => ReadonlyArray<BoxAlert>;
}

/** SNS subjects are one line of ASCII; Node's fetch throws on header characters above U+00FF. */
function subjectOf(title: string): string {
  let out = "";
  for (const ch of redact(title)) {
    const c = ch.codePointAt(0) ?? 0;
    out += c === 0x0a || c === 0x09 ? " " : c > 0x7e ? "?" : ch;
  }
  const subject = out.trim().slice(0, SUBJECT_MAX).trimEnd();
  return subject === "" ? "Alert" : subject;
}

export function makeAlertForwarder(deps: {
  readonly notifier: BoxNotifier;
  readonly now: () => number;
  readonly ids: () => string;
  readonly queueLimit?: number;
}): AlertForwarder {
  const limit = deps.queueLimit ?? 20;
  let queue: ReadonlyArray<BoxAlert> = [];

  const send = async (a: BoxAlert): Promise<void> => {
    await deps.notifier.publish({
      subject: subjectOf(a.title),
      body: a.body,
      attributes: { severity: a.severity, source: a.source, alertId: a.id },
    });
  };

  return {
    forward: async (alert) => {
      const a: BoxAlert = {
        ...alert,
        id: deps.ids(),
        at: deps.now(),
        title: redact(alert.title),
        body: redact(alert.body),
      };
      try {
        await send(a);
      } catch {
        queue = [...queue, a].slice(-limit);
      }
      return a.id;
    },
    retry: async (signal) => {
      let delivered = 0;
      for (const a of queue) {
        if (signal.aborted) break;
        try {
          await send(a);
        } catch {
          break;
        }
        queue = queue.filter((q) => q.id !== a.id);
        delivered++;
      }
      return delivered;
    },
    undelivered: () => queue.filter((a) => deps.now() - a.at >= UNDELIVERED_AFTER_MS),
  };
}
