// The built-in plugin table (part 6 §6.3 "Plugin registry"). A custom bundle spreads its own entries in.
import { emailSink, ntfySink, webhookSink, webPushSink } from "../alerts/index.ts";
import type { AlertSinkMaker } from "../ports/alertSink.ts";
import type { WakeSource } from "../ports/wakeSource.ts";
import { genericSource, githubSource } from "../wake/index.ts";

export const ALERT_SINKS: Readonly<Record<string, AlertSinkMaker<never>>> = {
  ntfy: ntfySink as AlertSinkMaker<never>,
  email: emailSink as AlertSinkMaker<never>,
  webpush: webPushSink as AlertSinkMaker<never>,
  webhook: webhookSink as AlertSinkMaker<never>,
};

export const WAKE_SOURCES: Readonly<Record<string, (getSecret: () => Promise<string | null>) => WakeSource>> = {
  github: githubSource,
  generic: genericSource,
};
