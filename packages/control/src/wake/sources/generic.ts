// C5: generic webhooks `POST /v1/hooks/generic/{topic}`: HMAC SHA-256 over the raw body in
// `X-Dozebox-Signature-256: sha256=<hex>`, `X-Dozebox-Timestamp` within 5 min, JSON body at most 64 KiB.
import type { WakeSource } from "../../ports/wakeSource.ts";

export const GENERIC_SKEW_MS = 5 * 60_000;
export const GENERIC_BODY_LIMIT_BYTES = 64 * 1024;

export function genericSource(_getSecret: () => Promise<string | null>): WakeSource {
  throw new Error("not implemented: C5 genericSource");
}
