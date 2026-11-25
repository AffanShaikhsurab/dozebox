import { strict as assert } from "node:assert";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { test } from "node:test";
import { makeFakeSecretReader } from "@dozebox/testkit/fakes";
import type { Alert } from "../src/ports/alertSink.ts";
import { encryptPayload, signVapidJwt, webPushSink } from "../src/alerts/sinks/webpush.ts";

// RFC 8291 section 5 and Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64u = (text: string) => Buffer.from(text, "base64url");

/** A receiver written independently of the sender. */
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20] as number;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ua.computeSecret(asPublic), auth, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  return record.subarray(0, record.lastIndexOf(0x02)).toString();
}

test("RFC 8291 Appendix A: encryptPayload reproduces the example body byte for byte", async () => {
  const body = await encryptPayload(
    Buffer.from(RFC.plaintext),
    { endpoint: "https://web.push.apple.com/x", keys: { p256dh: RFC.uaPublic, auth: RFC.auth } },
    unb64u(RFC.salt),
    { privateKey: unb64u(RFC.asPrivate), publicKey: unb64u(RFC.asPublic) },
  );
  assert.equal(body.length, 144);
  assert.equal(b64u(body), RFC.body);
  assert.equal(
    decrypt(Buffer.from(body), unb64u(RFC.uaPrivate), unb64u(RFC.uaPublic), unb64u(RFC.auth)),
    RFC.plaintext,
  );
});

test("encryptPayload left-pads a sender private key that lost its leading zero bytes", async () => {
  let sender: ReturnType<typeof createECDH>;
  do {
    sender = createECDH("prime256v1");
    sender.generateKeys();
  } while (sender.getPrivateKey().length === 32);
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const auth = randomBytes(16);
  const body = await encryptPayload(
    Buffer.from("hello"),
    { endpoint: "https://web.push.apple.com/x", keys: { p256dh: b64u(receiver.getPublicKey()), auth: b64u(auth) } },
    randomBytes(16),
    { privateKey: sender.getPrivateKey(), publicKey: sender.getPublicKey() },
  );
  assert.equal(decrypt(Buffer.from(body), receiver.getPrivateKey(), receiver.getPublicKey(), auth), "hello");
});

test("VAPID: 2,000 random P-256 keys, many with leading zero bytes, all sign JWTs that verify", () => {
  let short = 0;
  for (let i = 0; i < 2000; i++) {
    const scalar = randomBytes(32);
    // Keys below 2^248 (and so below the group order) lose their leading zero bytes in minimal encodings.
    scalar.fill(0, 0, i % 4);
    if (scalar.every((byte) => byte === 0)) continue;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(scalar);
    const publicKey = ecdh.getPublicKey();
    const stripped = scalar.subarray(scalar.findIndex((byte) => byte !== 0));
    if (stripped.length < 32) short++;
    const jwt = signVapidJwt({
      audience: "https://web.push.apple.com",
      subject: "mailto:ops@example.test",
      publicKey: b64u(publicKey),
      privateKey: b64u(i % 2 === 0 ? stripped : scalar),
      nowMs: 1_700_000_000_000,
    });
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    assert.equal(unb64u(signature).length, 64);
    const key = createPublicKey({
      format: "jwk",
      key: { kty: "EC", crv: "P-256", x: b64u(publicKey.subarray(1, 33)), y: b64u(publicKey.subarray(33, 65)) },
    });
    assert.ok(
      verify("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, unb64u(signature)),
    );
    assert.deepEqual(JSON.parse(unb64u(claims).toString()), {
      aud: "https://web.push.apple.com",
      exp: 1_700_000_000 + 12 * 3600,
      sub: "mailto:ops@example.test",
    });
  }
  assert.ok(short >= 1000, `only ${short} keys were shorter than 32 bytes`);
});

const alert: Alert = { id: "a-1", key: "k", severity: "notify", title: "t", body: "b", source: "runner:x", at: 1 };

function sinkFor(statuses: ReadonlyArray<number>) {
  const vapid = createECDH("prime256v1");
  vapid.generateKeys();
  const subs = statuses.map((_, i) => {
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    return {
      endpoint: `https://web.push.apple.com/sub-${i}`,
      keys: { p256dh: b64u(receiver.getPublicKey()), auth: b64u(randomBytes(16)) },
    };
  });
  const sent: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    sent.push(url);
    return new Response(null, { status: statuses[subs.findIndex((s) => s.endpoint === url)] ?? 500 });
  };
  const sink = webPushSink(
    {
      vapidPrivateSecret: "vapid",
      vapidPublicKey: b64u(vapid.getPublicKey()),
      subject: "mailto:ops@example.test",
      subscriptions: async () => subs,
    },
    { fetch: fetchFn, secrets: makeFakeSecretReader({ vapid: b64u(vapid.getPrivateKey()) }), log: { log: () => {} } },
  );
  return { sink, sent };
}

test("webpush: 404 and 410 from the push service are final: gone", async () => {
  for (const status of [404, 410]) {
    const { sink } = sinkFor([status]);
    assert.deepEqual(await sink.deliver(alert, new AbortController().signal), {
      ok: false,
      retryable: false,
      reason: "gone",
    });
  }
});

test("webpush: posts to every subscription, ok when any accepts, else retryable if any failure is", async () => {
  const { sink, sent } = sinkFor([201, 410, 503]);
  assert.deepEqual(await sink.deliver(alert, new AbortController().signal), { ok: true, receiptExpected: false });
  assert.deepEqual(
    sent.toSorted(),
    [0, 1, 2].map((i) => `https://web.push.apple.com/sub-${i}`),
  );
  const failing = sinkFor([410, 503]);
  assert.deepEqual(await failing.sink.deliver(alert, new AbortController().signal), {
    ok: false,
    retryable: true,
    reason: "http-503",
  });
});
