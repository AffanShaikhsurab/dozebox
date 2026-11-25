// C4: ntfy (priorities 1 to 5, Title/Priority/Tags/Click headers; the topic URL is a secret).
import type { AlertSeverity, AlertSinkMaker, DeliveryResult } from "../../ports/alertSink.ts";

export type NtfyConfig = { readonly urlSecret: string; readonly minSeverity?: AlertSeverity };

const RANK: Record<AlertSeverity, number> = { info: 0, notify: 1, page: 2 };
const PRIORITY: Record<AlertSeverity, string> = { page: "5", notify: "3", info: "2" };
const TAGS: Record<AlertSeverity, string> = {
  page: "rotating_light",
  notify: "bell",
  info: "information_source",
};

/** Maps an HTTP status to a delivery result: 2xx ok; 429 and 5xx retryable; other statuses are not. */
export function resultFromStatus(status: number): DeliveryResult {
  if (status >= 200 && status < 300) return { ok: true, receiptExpected: false };
  return { ok: false, retryable: status === 429 || status >= 500, reason: `http-${status}` };
}

/** Header values must be Latin-1 for `fetch`; ntfy reads RFC 2047 encoded words for anything else. */
function headerText(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  return `=?UTF-8?B?${Buffer.from(flat, "utf8").toString("base64")}?=`;
}

export const ntfySink: AlertSinkMaker<NtfyConfig> = (config, deps) => {
  const floor = RANK[config.minSeverity ?? "notify"];
  return {
    id: "ntfy",
    accepts: (severity) => RANK[severity] >= floor,
    deliver: async (alert, signal) => {
      let url: string | null;
      try {
        url = await deps.secrets.get(config.urlSecret);
      } catch {
        deps.log.log("warn", "ntfy secret read failed", { alert: alert.id });
        return { ok: false, retryable: true, reason: "secret-read-failed" };
      }
      if (url === null || url === "") {
        deps.log.log("warn", "ntfy url secret missing", { alert: alert.id });
        return { ok: false, retryable: false, reason: "missing-secret" };
      }
      const headers: Record<string, string> = {
        Title: headerText(alert.title),
        Priority: PRIORITY[alert.severity],
        Tags: TAGS[alert.severity],
      };
      if (alert.url !== undefined) headers["Click"] = encodeURI(alert.url);
      try {
        const res = await deps.fetch(url, { method: "POST", headers, body: alert.body, signal });
        const result = resultFromStatus(res.status);
        if (!result.ok) deps.log.log("warn", "ntfy rejected", { alert: alert.id, status: res.status });
        return result;
      } catch (err) {
        // The error text can carry the URL, so only its class is logged.
        deps.log.log("warn", "ntfy request failed", {
          alert: alert.id,
          error: err instanceof Error ? err.name : "unknown",
        });
        return { ok: false, retryable: true, reason: "network" };
      }
    },
  };
};
