// The sinks and wake sources a stack turned on in DOZEBOX_CONTROL, built from the plugin table. E-mail through the
// alert topic is always there: it is the sink of last resort.
import type { ControlConfig } from "../config.ts";
import type { AlertSink, SinkLogger } from "../ports/alertSink.ts";
import type { Notifier } from "../ports/notify.ts";
import type { SecretReader } from "../ports/sharedSecrets.ts";
import type { WakeSource } from "../ports/wakeSource.ts";
import { emailSink, ntfySink, webhookSink } from "../alerts/index.ts";
import { WAKE_SOURCES } from "./index.ts";

export type PluginDeps = {
  readonly notifier: Notifier;
  readonly secrets: SecretReader;
  readonly log: SinkLogger;
  readonly fetch?: typeof fetch;
};

export function buildSinks(cfg: ControlConfig, deps: PluginDeps): ReadonlyArray<AlertSink> {
  const sinkDeps = { fetch: deps.fetch ?? globalThis.fetch, secrets: deps.secrets, log: deps.log };
  const out: AlertSink[] = [emailSink({ notifier: deps.notifier }, sinkDeps)];
  const a = cfg.alerts;
  if (a?.ntfy !== undefined) out.push(ntfySink(a.ntfy, sinkDeps));
  if (a?.webhook !== undefined) out.push(webhookSink(a.webhook, sinkDeps));
  return out;
}

export function buildWakeSources(cfg: ControlConfig, secrets: SecretReader): ReadonlyArray<WakeSource> {
  const out: WakeSource[] = [];
  for (const [id, hook] of Object.entries(cfg.hooks ?? {})) {
    const make = WAKE_SOURCES[id];
    if (make !== undefined && hook !== undefined) out.push(make(() => secrets.get(hook.secret)));
  }
  return out;
}
