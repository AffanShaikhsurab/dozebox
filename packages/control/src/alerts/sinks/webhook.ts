// C4: generic webhook: JSON POST signed with HMAC SHA-256 (`X-Dozebox-Signature-256`, `X-Dozebox-Timestamp`).
import { createHmac } from "node:crypto";
import type { AlertSinkMaker } from "../../ports/alertSink.ts";
import { resultFromStatus } from "./ntfy.ts";

export type WebhookConfig = { readonly urlSecret: string; readonly signingSecret: string };

export const webhookSink: AlertSinkMaker<WebhookConfig> = (config, deps) => ({
  id: "webhook",
  accepts: () => true,
  deliver: async (alert, signal) => {
    let url: string | null;
    let key: string | null;
    try {
      [url, key] = await Promise.all([deps.secrets.get(config.urlSecret), deps.secrets.get(config.signingSecret)]);
    } catch {
      deps.log.log("warn", "webhook secret read failed", { alert: alert.id });
      return { ok: false, retryable: true, reason: "secret-read-failed" };
    }
    if (url === null || url === "" || key === null || key === "") {
      deps.log.log("warn", "webhook secret missing", { alert: alert.id });
      return { ok: false, retryable: false, reason: "missing-secret" };
    }
    const body = JSON.stringify(alert);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
    try {
      const res = await deps.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Dozebox-Timestamp": timestamp,
          "X-Dozebox-Signature-256": `sha256=${signature}`,
        },
        body,
        signal,
      });
      const result = resultFromStatus(res.status);
      if (!result.ok) deps.log.log("warn", "webhook rejected", { alert: alert.id, status: res.status });
      return result;
    } catch (err) {
      deps.log.log("warn", "webhook request failed", {
        alert: alert.id,
        error: err instanceof Error ? err.name : "unknown",
      });
      return { ok: false, retryable: true, reason: "network" };
    }
  },
});
