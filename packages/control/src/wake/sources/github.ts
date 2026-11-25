// C5: GitHub webhooks (HMAC SHA-256 in X-Hub-Signature-256, X-GitHub-Delivery as the dedupe key, answer in 10 s).
import type { WakeSource } from "../../ports/wakeSource.ts";

export function githubSource(_getSecret: () => Promise<string | null>): WakeSource {
  throw new Error("not implemented: C5 githubSource");
}
