// C4: Web Push (RFC 8291 aes128gcm, VAPID RFC 8292), ported from legacy webpush.mjs with the left-pad fix.
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";
import type { AlertSeverity, AlertSinkMaker, DeliveryResult } from "../../ports/alertSink.ts";
import { resultFromStatus } from "./ntfy.ts";

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

const CURVE = "prime256v1";
const SALT_BYTES = 16;
const AUTH_BYTES = 16;
const PUBLIC_KEY_BYTES = 65;
const TAG_BYTES = 16;
const RECORD_SIZE = 4096;
const HEADER_BYTES = SALT_BYTES + 4 + 1 + PUBLIC_KEY_BYTES;
/** RFC 8291 section 4: a push service need not accept more than 4096 octets of body. */
const MAX_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_BYTES - 1 - TAG_BYTES;
const VAPID_LIFETIME_S = 12 * 60 * 60;
const TTL_S = 24 * 60 * 60;
const URGENCY: Record<AlertSeverity, string> = { page: "high", notify: "normal", info: "low" };

/** Push services we deliver to; a stored endpoint outside this list is never fetched. */
const PUSH_HOST_SUFFIXES = [
  "web.push.apple.com",
  "push.apple.com",
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "notify.windows.com",
];

class WebPushError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WebPushError";
    this.code = code;
  }
}

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

function b64uDecode(text: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new WebPushError("bad-base64url", `${label} is not base64url`);
  return Buffer.from(text.replace(/=+$/, ""), "base64url");
}

/** P-256 scalars and coordinates are 32 bytes; encoders that drop leading zeros give shorter ones. */
function leftPad32(bytes: Uint8Array, label: string): Buffer {
  if (bytes.length > 32) throw new WebPushError("bad-key", `${label} is longer than 32 bytes`);
  return Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
}

function publicPoint(text: string, label: string): Buffer {
  const bytes = b64uDecode(text, label);
  if (bytes.length !== PUBLIC_KEY_BYTES || bytes[0] !== 0x04) {
    throw new WebPushError("bad-public-key", `${label} must be a 65-byte uncompressed P-256 point`);
  }
  return bytes;
}

/**
 * ES256 JWT (RFC 8292). `privateKey` is the base64url scalar, possibly shorter than 32 bytes.
 * Exported for the property test.
 */
export function signVapidJwt(args: {
  readonly audience: string;
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly nowMs: number;
}): string {
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(args.subject)) {
    throw new WebPushError("bad-vapid-subject", "VAPID subject must be a mailto: or https: URL");
  }
  const d = leftPad32(b64uDecode(args.privateKey, "VAPID private key"), "VAPID private key");
  const point = publicPoint(args.publicKey, "VAPID public key");
  const key = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: b64u(d),
      x: b64u(leftPad32(point.subarray(1, 33), "x")),
      y: b64u(leftPad32(point.subarray(33, 65), "y")),
    },
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud: args.audience,
        exp: Math.floor(args.nowMs / 1000) + VAPID_LIFETIME_S,
        sub: args.subject,
      }),
    ),
  );
  const input = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  // r and s are fixed 32-byte fields in P1363 form, zero-padded on the left.
  if (signature.length !== 64) throw new WebPushError("bad-signature", "ES256 signature is not 64 bytes");
  return `${input}.${b64u(signature)}`;
}

const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/** RFC 8291 §3 message encryption into one aes128gcm record; exported for the Appendix A test vector. */
export async function encryptPayload(
  plaintext: Uint8Array,
  sub: PushSubscription,
  salt: Uint8Array,
  /** The sender's ephemeral P-256 key pair: raw 32-byte private key, 65-byte uncompressed public key. */
  serverKey: { readonly privateKey: Uint8Array; readonly publicKey: Uint8Array },
): Promise<Uint8Array> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new WebPushError("payload-too-large", `payload is over ${MAX_PLAINTEXT_BYTES} bytes`);
  }
  if (salt.length !== SALT_BYTES) throw new WebPushError("bad-salt", `salt must be ${SALT_BYTES} bytes`);
  const receiver = publicPoint(sub.keys.p256dh, "subscription p256dh");
  const auth = b64uDecode(sub.keys.auth, "subscription auth");
  if (auth.length !== AUTH_BYTES) throw new WebPushError("bad-auth-secret", `auth must be ${AUTH_BYTES} bytes`);

  const sender = createECDH(CURVE);
  sender.setPrivateKey(leftPad32(serverKey.privateKey, "sender private key"));
  const senderPublic = Buffer.from(serverKey.publicKey);
  if (!sender.getPublicKey().equals(senderPublic)) {
    throw new WebPushError("bad-sender-key", "sender public key does not match the private key");
  }
  const shared = sender.computeSecret(receiver);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiver, senderPublic]);
  const ikm = hkdf(shared, auth, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([senderPublic.length]), senderPublic, ciphertext]);
}

function endpointOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new WebPushError("bad-endpoint", "endpoint is not a URL");
  }
  const host = url.hostname.toLowerCase();
  const known = PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || !known) {
    throw new WebPushError("bad-endpoint", "endpoint is not a plain https URL of a known push service");
  }
  return url.origin;
}

export const webPushSink: AlertSinkMaker<WebPushConfig> = (config, deps) => {
  async function pushOne(
    sub: PushSubscription,
    payload: Buffer,
    authKey: string,
    severity: AlertSeverity,
    alertId: string,
    signal: AbortSignal,
  ): Promise<DeliveryResult> {
    let request: { readonly headers: Record<string, string>; readonly body: Uint8Array<ArrayBuffer> };
    try {
      const origin = endpointOrigin(sub.endpoint);
      const jwt = signVapidJwt({
        audience: origin,
        subject: config.subject,
        publicKey: config.vapidPublicKey,
        privateKey: authKey,
        nowMs: Date.now(),
      });
      const ephemeral = createECDH(CURVE);
      ephemeral.generateKeys();
      const body = await encryptPayload(payload, sub, randomBytes(SALT_BYTES), {
        privateKey: leftPad32(ephemeral.getPrivateKey(), "ephemeral key"),
        publicKey: ephemeral.getPublicKey(),
      });
      request = {
        body: new Uint8Array(body),
        headers: {
          Authorization: `vapid t=${jwt}, k=${b64u(publicPoint(config.vapidPublicKey, "VAPID public key"))}`,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: String(TTL_S),
          Urgency: URGENCY[severity],
        },
      };
    } catch (err) {
      const code = err instanceof WebPushError ? err.code : "encrypt-failed";
      deps.log.log("warn", "webpush request not built", { alert: alertId, code });
      return { ok: false, retryable: false, reason: code };
    }
    try {
      const res = await deps.fetch(sub.endpoint, { method: "POST", ...request, redirect: "error", signal });
      if (res.status === 404 || res.status === 410) return { ok: false, retryable: false, reason: "gone" };
      const result = resultFromStatus(res.status);
      if (!result.ok) deps.log.log("warn", "webpush rejected", { alert: alertId, status: res.status });
      return result;
    } catch (err) {
      deps.log.log("warn", "webpush request failed", {
        alert: alertId,
        error: err instanceof Error ? err.name : "unknown",
      });
      return { ok: false, retryable: true, reason: "network" };
    }
  }

  return {
    id: "webpush",
    accepts: () => true,
    deliver: async (alert, signal) => {
      let authKey: string | null;
      let subs: ReadonlyArray<PushSubscription>;
      try {
        authKey = await deps.secrets.get(config.vapidPrivateSecret);
        if (authKey === null || authKey === "") {
          deps.log.log("warn", "webpush vapid secret missing", { alert: alert.id });
          return { ok: false, retryable: false, reason: "missing-secret" };
        }
        subs = await config.subscriptions();
      } catch {
        deps.log.log("warn", "webpush setup failed", { alert: alert.id });
        return { ok: false, retryable: true, reason: "setup-failed" };
      }
      if (subs.length === 0) return { ok: false, retryable: false, reason: "no-subscriptions" };
      const payload = Buffer.from(
        JSON.stringify({
          id: alert.id,
          title: alert.title,
          body: alert.body,
          url: alert.url,
          severity: alert.severity,
        }),
      );
      const results = await Promise.all(
        subs.map((sub) => pushOne(sub, payload, authKey, alert.severity, alert.id, signal)),
      );
      if (results.some((r) => r.ok)) return { ok: true, receiptExpected: false };
      const failures = results.filter((r) => !r.ok);
      return failures.find((r) => r.retryable) ?? failures[0] ?? { ok: false, retryable: false, reason: "none" };
    },
  };
};
