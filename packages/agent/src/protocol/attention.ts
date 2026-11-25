// A2: attention dedupe and rates (part 4 §4.10): the same key within `dedupeSeconds` is accepted but not sent again;
// 30 per hour per payload and 5 `page` per hour, deduped calls not counted. In memory: a restart forgets it.
import type { AttentionInput } from "@dozebox/protocol/v1";
import { ProtocolError } from "./errors.ts";
import { LIMITS } from "./limits.ts";

const HOUR_MS = 60 * 60_000;
export const DEFAULT_DEDUPE_SECONDS = 3600;

export interface AttentionGate {
  /** The earlier alert id when `input.key` is inside its dedupe window, else null. Throws `rate_limited`. */
  readonly admit: (payload: string, input: AttentionInput, now: number) => string | null;
  readonly sent: (payload: string, input: AttentionInput, alertId: string, now: number) => void;
}

export function makeAttentionGate(): AttentionGate {
  const seen = new Map<string, { readonly alertId: string; readonly until: number }>();
  const sends = new Map<string, Array<{ readonly at: number; readonly page: boolean }>>();

  const recent = (payload: string, now: number): Array<{ readonly at: number; readonly page: boolean }> => {
    const list = (sends.get(payload) ?? []).filter((s) => s.at > now - HOUR_MS);
    sends.set(payload, list);
    return list;
  };

  return {
    admit: (payload, input, now) => {
      const key = `${payload}\n${input.key}`;
      const prior = seen.get(key);
      if (prior !== undefined && prior.until > now) return prior.alertId;
      const list = recent(payload, now);
      const pages = list.filter((s) => s.page);
      const over =
        list.length >= LIMITS.attentionPerHour
          ? list
          : input.severity === "page" && pages.length >= LIMITS.pagesPerHour
            ? pages
            : null;
      if (over !== null) {
        const oldest = over[0]?.at ?? now;
        throw new ProtocolError("rate_limited", "too many attention calls this hour", {
          retryAfter: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000)),
        });
      }
      return null;
    },
    sent: (payload, input, alertId, now) => {
      const dedupeMs = (input.dedupeSeconds ?? DEFAULT_DEDUPE_SECONDS) * 1000;
      if (dedupeMs > 0) seen.set(`${payload}\n${input.key}`, { alertId, until: now + dedupeMs });
      recent(payload, now).push({ at: now, page: input.severity === "page" });
      for (const [k, v] of seen) if (v.until <= now) seen.delete(k);
    },
  };
}
