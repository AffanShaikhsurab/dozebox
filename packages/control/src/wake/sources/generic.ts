// C5: generic webhooks `POST /v1/hooks/generic/{topic}`: HMAC SHA-256 over `<timestamp>.<raw body>` in
// `X-Dozebox-Signature-256: sha256=<hex>`, `X-Dozebox-Timestamp` (seconds) within 5 min, JSON body at most 64 KiB.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { WakeSource } from "../../ports/wakeSource.ts";

export const GENERIC_SKEW_MS = 5 * 60_000;
export const GENERIC_BODY_LIMIT_BYTES = 64 * 1024;

const PREFIX = "/v1/hooks/generic/";

type GenericFilter = { readonly source?: string; readonly topic?: string };

function topicOf(path: string): string {
  return path.startsWith(PREFIX) ? path.slice(PREFIX.length) : "";
}

export function genericSource(getSecret: () => Promise<string | null>): WakeSource {
  return {
    id: "generic",
    route: { method: "POST", path: PREFIX },
    verify: async (req, now) => {
      if (req.rawBody.length > GENERIC_BODY_LIMIT_BYTES) return false;
      const secret = await getSecret();
      const sig = req.headers["x-dozebox-signature-256"];
      const stamp = req.headers["x-dozebox-timestamp"];
      if (!secret || !sig?.startsWith("sha256=") || !stamp || !/^\d+$/.test(stamp)) return false;
      if (Math.abs(now - Number(stamp) * 1000) > GENERIC_SKEW_MS) return false;
      const mac = createHmac("sha256", secret).update(`${stamp}.`).update(req.rawBody).digest("hex");
      const want = Buffer.from(`sha256=${mac}`);
      const got = Buffer.from(sig);
      return got.length === want.length && timingSafeEqual(got, want);
    },
    match: (req, wakes, now) => {
      const topic = topicOf(req.path);
      if (topic === "") return { wake: false, why: "no-topic" };
      const hits = wakes.filter((w) => {
        const on = w.on as GenericFilter | null | undefined;
        return on?.source === "generic" && on.topic === topic && Date.parse(w.expiresAt) >= now;
      });
      if (hits.length === 0) return { wake: false, why: "no-matching-wake" };
      const digest = createHash("sha256").update(req.rawBody).digest("hex");
      return {
        wake: true,
        why: `generic:${topic}`,
        wakeIds: hits.map((w) => `${w.payload}/${w.id}`),
        dedupeKey: `generic:${topic}:${digest}`,
      };
    },
  };
}
