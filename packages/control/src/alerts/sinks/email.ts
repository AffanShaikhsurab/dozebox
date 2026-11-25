// C4: e-mail through the alert SNS topic. The last sink: never skipped by the breaker.
import type { AlertSinkMaker } from "../../ports/alertSink.ts";
import type { Notifier } from "../../ports/notify.ts";

export type EmailConfig = { readonly notifier: Notifier };

export const emailSink: AlertSinkMaker<EmailConfig> = (config, deps) => ({
  id: "email",
  accepts: () => true,
  deliver: async (alert) => {
    try {
      await config.notifier.publish({
        subject: alert.title,
        body: alert.body,
        attributes: { severity: alert.severity, kind: "alert" },
      });
      return { ok: true, receiptExpected: false };
    } catch (err) {
      deps.log.log("warn", "email publish failed", {
        alert: alert.id,
        error: err instanceof Error ? err.name : "unknown",
      });
      return { ok: false, retryable: true, reason: "publish-failed" };
    }
  },
});
