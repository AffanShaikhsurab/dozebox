// C4: generic webhook: JSON POST signed with HMAC SHA-256 (`X-Dozebox-Signature-256`, `X-Dozebox-Timestamp`).
import type { AlertSinkMaker } from "../../ports/alertSink.ts";

export type WebhookConfig = { readonly urlSecret: string; readonly signingSecret: string };

export const webhookSink: AlertSinkMaker<WebhookConfig> = () => {
  throw new Error("not implemented: C4 webhookSink");
};
