import { strict as assert } from "node:assert";
import { createECDH, createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { makeFakeSecretReader } from "@dozebox/testkit/fakes";
import type { Alert, AlertSink, SinkDeps, SinkLogger } from "../src/ports/alertSink.ts";
import { emailSink } from "../src/alerts/sinks/email.ts";
import { ntfySink } from "../src/alerts/sinks/ntfy.ts";
import { webhookSink } from "../src/alerts/sinks/webhook.ts";
import { webPushSink } from "../src/alerts/sinks/webpush.ts";

const NTFY_URL = "https://ntfy.example.test/topic-s3cr3t-abc";
const HOOK_URL = "https://hooks.example.test/in/s3cr3t-def";
const HOOK_KEY = "signing-s3cr3t-ghi";
const VAPID_PUBLIC_RAW = (() => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey().toString("base64url"),
    publicKey: ecdh.getPublicKey().toString("base64url"),
  };
})();

const alert: Alert = {
  id: "a-1",
  key: "k-1",
  severity: "page",
  title: "Box needs you",
  body: "parked for 10 minutes",
  url: "https://example.test/box",
  source: "runner:agent",
  at: 1_000,
};

type Call = {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: unknown;
};
type Reply = number | Error;

function fakeFetch(reply: Reply) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method, headers: new Headers(init?.headers), body: init?.body });
    if (reply instanceof Error) throw reply;
    return new Response(null, { status: reply });
  };
  return { fetch: fetchFn, calls };
}

function fakeLog() {
  const lines: string[] = [];
  const log: SinkLogger = { log: (level, msg, fields) => void lines.push(JSON.stringify({ level, msg, fields })) };
  return { log, lines };
}

function subscription() {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  return {
    endpoint: "https://web.push.apple.com/tok-s3cr3t-jkl",
    keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
}

type Subject = {
  readonly id: string;
  readonly secrets: Record<string, string>;
  readonly make: (deps: SinkDeps) => AlertSink;
  /** Values that must never reach a log line. */
  readonly sensitive: readonly string[];
};

const sub = subscription();
const subjects: readonly Subject[] = [
  {
    id: "ntfy",
    secrets: { "ntfy-url": NTFY_URL },
    make: (deps) => ntfySink({ urlSecret: "ntfy-url" }, deps),
    sensitive: [NTFY_URL, "topic-s3cr3t-abc"],
  },
  {
    id: "webhook",
    secrets: { "hook-url": HOOK_URL, "hook-key": HOOK_KEY },
    make: (deps) => webhookSink({ urlSecret: "hook-url", signingSecret: "hook-key" }, deps),
    sensitive: [HOOK_URL, "s3cr3t-def", HOOK_KEY],
  },
  {
    id: "webpush",
    secrets: { "vapid-private": VAPID_PUBLIC_RAW.privateKey },
    make: (deps) =>
      webPushSink(
        {
          vapidPrivateSecret: "vapid-private",
          vapidPublicKey: VAPID_PUBLIC_RAW.publicKey,
          subject: "mailto:ops@example.test",
          subscriptions: async () => [sub],
        },
        deps,
      ),
    sensitive: [sub.endpoint, "tok-s3cr3t-jkl", sub.keys.auth, VAPID_PUBLIC_RAW.privateKey],
  },
];

function run(subject: Subject, reply: Reply, secrets = subject.secrets) {
  const f = fakeFetch(reply);
  const l = fakeLog();
  const sink = subject.make({ fetch: f.fetch, secrets: makeFakeSecretReader(secrets), log: l.log });
  return { sink, calls: f.calls, lines: l.lines };
}

for (const subject of subjects) {
  const table: ReadonlyArray<readonly [string, Reply, boolean | "retry" | "final"]> = [
    ["200 is ok", 200, true],
    ["201 is ok", 201, true],
    ["429 is retryable", 429, "retry"],
    ["503 is retryable", 503, "retry"],
    ["500 is retryable", 500, "retry"],
    ["network error is retryable", new TypeError(`fetch failed for ${NTFY_URL} ${HOOK_URL} ${sub.endpoint}`), "retry"],
    ["400 is not retryable", 400, "final"],
    ["401 is not retryable", 401, "final"],
  ];
  for (const [name, reply, expected] of table) {
    test(`${subject.id}: ${name}, and nothing secret is logged`, async () => {
      const { sink, lines } = run(subject, reply);
      const result = await sink.deliver(alert, new AbortController().signal);
      if (expected === true) assert.equal(result.ok, true);
      else {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.retryable, expected === "retry");
      }
      for (const line of lines)
        for (const secret of subject.sensitive) assert.ok(!line.includes(secret), `${line} leaks a secret`);
    });
  }

  test(`${subject.id}: a missing secret is not retryable and makes no request`, async () => {
    const { sink, calls, lines } = run(subject, 200, {});
    const result = await sink.deliver(alert, new AbortController().signal);
    assert.deepEqual(result, { ok: false, retryable: false, reason: "missing-secret" });
    assert.equal(calls.length, 0);
    for (const line of lines) for (const secret of subject.sensitive) assert.ok(!line.includes(secret));
  });
}

test("ntfy: accepts honours minSeverity, default notify", () => {
  const deps = { fetch: fakeFetch(200).fetch, secrets: makeFakeSecretReader(), log: fakeLog().log };
  const accepted = (min?: "info" | "notify" | "page") =>
    (["info", "notify", "page"] as const).filter(
      ntfySink(min === undefined ? { urlSecret: "u" } : { urlSecret: "u", minSeverity: min }, deps).accepts,
    );
  assert.deepEqual(accepted(), ["notify", "page"]);
  assert.deepEqual(accepted("info"), ["info", "notify", "page"]);
  assert.deepEqual(accepted("page"), ["page"]);
});

test("ntfy: posts the body to the secret URL with Title, Priority, Tags and Click", async () => {
  const subject = subjects[0] as Subject;
  const { sink, calls } = run(subject, 200);
  await sink.deliver(alert, new AbortController().signal);
  const call = calls[0] as Call;
  assert.equal(call.url, NTFY_URL);
  assert.equal(call.method, "POST");
  assert.equal(call.body, alert.body);
  assert.equal(call.headers.get("title"), "Box needs you");
  assert.equal(call.headers.get("priority"), "5");
  assert.ok((call.headers.get("tags") ?? "").length > 0);
  assert.equal(call.headers.get("click"), alert.url);
});

test("ntfy: severity maps to priority, a missing url sends no Click, non-ASCII titles are encoded", async () => {
  const subject = subjects[0] as Subject;
  for (const [severity, priority] of [
    ["page", "5"],
    ["notify", "3"],
    ["info", "2"],
  ] as const) {
    const { sink, calls } = run(subject, 200);
    const { url: _url, ...bare } = alert;
    await sink.deliver({ ...bare, severity, title: "Disk caf\u00e9 full" }, new AbortController().signal);
    const call = calls[0] as Call;
    assert.equal(call.headers.get("priority"), priority);
    assert.equal(call.headers.get("click"), null);
    assert.equal(call.headers.get("title"), `=?UTF-8?B?${Buffer.from("Disk caf\u00e9 full").toString("base64")}?=`);
  }
});

test("email: publishes subject, body and attributes, accepts every severity", async () => {
  const published: unknown[] = [];
  const deps = { fetch: fakeFetch(200).fetch, secrets: makeFakeSecretReader(), log: fakeLog().log };
  const sink = emailSink({ notifier: { publish: async (n) => (published.push(n), "m-1") } }, deps);
  assert.deepEqual((["info", "notify", "page"] as const).filter(sink.accepts), ["info", "notify", "page"]);
  assert.deepEqual(await sink.deliver(alert, new AbortController().signal), { ok: true, receiptExpected: false });
  assert.deepEqual(published, [
    { subject: alert.title, body: alert.body, attributes: { severity: "page", kind: "alert" } },
  ]);
});

test("email: a publish failure becomes a retryable result without leaking the error text", async () => {
  const l = fakeLog();
  const sink = emailSink(
    { notifier: { publish: async () => Promise.reject(new Error("arn:aws:sns:secret-topic")) } },
    { fetch: fakeFetch(200).fetch, secrets: makeFakeSecretReader(), log: l.log },
  );
  const result = await sink.deliver(alert, new AbortController().signal);
  assert.deepEqual(result, { ok: false, retryable: true, reason: "publish-failed" });
  assert.ok(l.lines.every((line) => !line.includes("secret-topic")));
});

test("webhook: signs `<timestamp>.<body>` with HMAC SHA-256 and posts the alert as JSON", async () => {
  const { sink, calls } = run(subjects[1] as Subject, 200);
  await sink.deliver(alert, new AbortController().signal);
  const call = calls[0] as Call;
  assert.equal(call.url, HOOK_URL);
  assert.equal(call.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(call.body)), alert);
  const timestamp = call.headers.get("x-dozebox-timestamp") ?? "";
  assert.match(timestamp, /^\d{10}$/);
  const expected = createHmac("sha256", HOOK_KEY)
    .update(`${timestamp}.${String(call.body)}`)
    .digest("hex");
  assert.equal(call.headers.get("x-dozebox-signature-256"), `sha256=${expected}`);
});

test("webhook: a missing signing secret alone is not retryable", async () => {
  const { sink, calls } = run(subjects[1] as Subject, 200, { "hook-url": HOOK_URL });
  assert.deepEqual(await sink.deliver(alert, new AbortController().signal), {
    ok: false,
    retryable: false,
    reason: "missing-secret",
  });
  assert.equal(calls.length, 0);
});
