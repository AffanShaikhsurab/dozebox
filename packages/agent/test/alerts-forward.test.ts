// makeAlertForwarder: send, queue on failure, in-order retry, bound, header-safe subject, redaction, undelivered age.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeAlertForwarder, UNDELIVERED_AFTER_MS } from "../src/alerts/index.ts";
import type { BoxNotice } from "../src/ports/notify.ts";

function setup(opts: { readonly queueLimit?: number } = {}) {
  let now = 1_000;
  let n = 0;
  const sent: BoxNotice[] = [];
  const state = { down: false };
  const f = makeAlertForwarder({
    notifier: {
      publish: async (notice) => {
        if (state.down) throw new Error("sns down");
        sent.push(notice);
        return `m${sent.length}`;
      },
    },
    now: () => now,
    ids: () => `a${++n}`,
    ...opts,
  });
  return { f, sent, state, tick: (ms: number) => void (now += ms) };
}

const alert = (title: string, body = "b") => ({ source: "runner", severity: "notify" as const, title, body });

test("a sent alert returns its id and publishes subject, body and attributes", async () => {
  const s = setup();
  const id = await s.f.forward({ source: "runner", severity: "page", title: "Disk low", body: "91% used" });
  assert.equal(id, "a1");
  assert.deepEqual(s.sent, [
    { subject: "Disk low", body: "91% used", attributes: { severity: "page", source: "runner", alertId: "a1" } },
  ]);
  assert.deepEqual(s.f.undelivered(), []);
});

test("a send failure queues the alert and never throws", async () => {
  const s = setup();
  s.state.down = true;
  assert.equal(await s.f.forward(alert("one")), "a1");
  s.tick(UNDELIVERED_AFTER_MS);
  assert.deepEqual(
    s.f.undelivered().map((a) => a.id),
    ["a1"],
  );
});

test("retry delivers the queue oldest first and stops at the first failure", async () => {
  const s = setup();
  s.state.down = true;
  for (const t of ["one", "two", "three"]) await s.f.forward(alert(t));
  assert.equal(await s.f.retry(new AbortController().signal), 0);
  s.state.down = false;
  assert.equal(await s.f.retry(new AbortController().signal), 3);
  assert.deepEqual(
    s.sent.map((m) => m.subject),
    ["one", "two", "three"],
  );
  assert.equal(await s.f.retry(new AbortController().signal), 0);
});

test("retry stops at the first failure and keeps the rest queued", async () => {
  let now = 0;
  let allow = 1;
  const sent: string[] = [];
  let n = 0;
  const f = makeAlertForwarder({
    notifier: {
      publish: async (m) => {
        if (allow-- <= 0) throw new Error("down");
        sent.push(m.subject);
        return "m";
      },
    },
    now: () => now,
    ids: () => `a${++n}`,
  });
  allow = 0;
  for (const t of ["one", "two", "three"]) await f.forward({ source: "r", severity: "notify", title: t, body: "" });
  allow = 1;
  assert.equal(await f.retry(new AbortController().signal), 1);
  assert.deepEqual(sent, ["one"]);
  now += UNDELIVERED_AFTER_MS;
  assert.deepEqual(
    f.undelivered().map((a) => a.title),
    ["two", "three"],
  );
});

test("the queue is bounded and drops the oldest", async () => {
  const s = setup({ queueLimit: 2 });
  s.state.down = true;
  for (const t of ["one", "two", "three"]) await s.f.forward(alert(t));
  s.tick(UNDELIVERED_AFTER_MS);
  assert.deepEqual(
    s.f.undelivered().map((a) => a.title),
    ["two", "three"],
  );
});

test("the subject is one line of ASCII, at most 100 characters", async () => {
  const s = setup();
  await s.f.forward(alert("Disk \u{1F4A5} low\nsecond line"));
  await s.f.forward(alert("x".repeat(250)));
  await s.f.forward(alert("\u{1F4A5}"));
  const subjects = s.sent.map((m) => m.subject);
  assert.equal(subjects[0], "Disk ? low second line");
  assert.equal(subjects[1]?.length, 100);
  assert.equal(subjects[2], "?");
  for (const sub of subjects) assert.match(sub, /^[\x20-\x7e]+$/);
});

test("title and body are redacted before they leave", async () => {
  const s = setup();
  await s.f.forward(alert("mail jane@example.com", "key AKIAIOSFODNN7EXAMPLE in /home/ubuntu/x"));
  assert.equal(s.sent[0]?.subject, "mail [redacted]");
  assert.equal(s.sent[0]?.body, "key [redacted] in /home/[redacted]/x");
});

test("undelivered lists only alerts that waited 10 minutes", async () => {
  const s = setup();
  s.state.down = true;
  await s.f.forward(alert("old"));
  s.tick(UNDELIVERED_AFTER_MS - 1);
  await s.f.forward(alert("new"));
  assert.deepEqual(s.f.undelivered(), []);
  s.tick(1);
  assert.deepEqual(
    s.f.undelivered().map((a) => a.title),
    ["old"],
  );
  s.tick(UNDELIVERED_AFTER_MS);
  assert.equal(s.f.undelivered().length, 2);
});
