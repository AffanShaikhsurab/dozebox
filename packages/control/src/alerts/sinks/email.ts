// C4: e-mail through the alert SNS topic. The last sink: never skipped by the breaker.
import type { AlertSinkMaker } from "../../ports/alertSink.ts";
import type { Notifier } from "../../ports/notify.ts";

export type EmailConfig = { readonly notifier: Notifier };

export const emailSink: AlertSinkMaker<EmailConfig> = () => {
  throw new Error("not implemented: C4 emailSink");
};
