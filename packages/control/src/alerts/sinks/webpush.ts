// C4: Web Push (RFC 8291 aes128gcm, VAPID RFC 8292), ported from legacy webpush.mjs with the left-pad fix.
import type { AlertSinkMaker } from "../../ports/alertSink.ts";

export type PushSubscription = {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
};

export type WebPushConfig = {
  /** Secret names of the VAPID key pair and the subject (`mailto:` or `https:`). */
  readonly vapidPrivateSecret: string;
  readonly vapidPublicKey: string;
  readonly subject: string;
  readonly subscriptions: () => Promise<ReadonlyArray<PushSubscription>>;
};

export const webPushSink: AlertSinkMaker<WebPushConfig> = () => {
  throw new Error("not implemented: C4 webPushSink");
};

/** RFC 8291 §3 message encryption; exported for the Appendix A test vector. */
export function encryptPayload(
  _plaintext: Uint8Array,
  _sub: PushSubscription,
  _salt: Uint8Array,
  /** The sender's ephemeral P-256 key pair: raw 32-byte private key, 65-byte uncompressed public key. */
  _serverKey: { readonly privateKey: Uint8Array; readonly publicKey: Uint8Array },
): Promise<Uint8Array> {
  throw new Error("not implemented: C4 encryptPayload");
}
