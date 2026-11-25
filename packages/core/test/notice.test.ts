import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "../src/errors.ts";
import { shapeSnsNotice } from "../src/notice.ts";

const bytes = (s: string): number => new TextEncoder().encode(s).length;

test("a plain notice passes unchanged", () => {
  assert.deepEqual(shapeSnsNotice({ subject: "Dozebox: box-1", body: "parked", attributes: { severity: "page" } }), {
    subject: "Dozebox: box-1",
    message: "parked",
    attributes: { severity: "page" },
  });
});

test("non-ASCII subject: accents folded, emoji dropped, never refused", () => {
  const r = shapeSnsNotice({ subject: "Run 42 ✅ needs you 🚨 – café", body: "b" });
  assert.equal(r.subject, "Run 42 needs you cafe");
});

test("line breaks, tabs and control characters become one space or nothing", () => {
  const r = shapeSnsNotice({ subject: "  one\r\ntwo\tthree\u0007  ", body: "b" });
  assert.equal(r.subject, "one two three");
});

test("a long subject is cut under 100 characters with an ellipsis", () => {
  const r = shapeSnsNotice({ subject: "x".repeat(150), body: "b" });
  assert.equal(r.subject?.length, 99);
  assert.ok(r.subject?.endsWith("..."));
  assert.equal(shapeSnsNotice({ subject: "y".repeat(99), body: "b" }).subject, "y".repeat(99));
});

test("a subject with nothing printable is left out; an empty body gets the subject", () => {
  const r = shapeSnsNotice({ subject: "🚨🚨", body: "" });
  assert.equal("subject" in r, false);
  assert.equal(r.message, "(no message)");
  assert.equal(shapeSnsNotice({ subject: "hello", body: "" }).message, "hello");
});

test("a body over 256 KiB with its attributes is cut at a character boundary with a marker", () => {
  const body = "é".repeat(200_000); // 400,000 bytes
  const r = shapeSnsNotice({ subject: "s", body, attributes: { severity: "info" } });
  const total = bytes(r.message) + bytes("severity") + bytes("String") + bytes("info");
  assert.ok(total <= 262_144, `total ${total}`);
  assert.ok(total > 262_144 - 16, `total ${total}`);
  assert.ok(r.message.endsWith("\n[truncated]"));
  assert.ok(!r.message.includes("\uFFFD"));
  const fits = "a".repeat(262_144);
  assert.equal(shapeSnsNotice({ subject: "s", body: fits }).message, fits);
});

const refused = (attributes: Record<string, string>) =>
  assert.throws(
    () => shapeSnsNotice({ subject: "s", body: "b", attributes }),
    (e: unknown) => e instanceof RunnerError && e.code === "invalid_input" && !e.retryable,
  );

test("bad attributes are refused as invalid_input", () => {
  refused({ "AWS.x": "1" });
  refused({ "amazon.x": "1" });
  refused({ ".x": "1" });
  refused({ "x.": "1" });
  refused({ "a..b": "1" });
  refused({ "a b": "1" });
  refused({ "": "1" });
  refused({ key: "" });
  refused(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])));
  const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k.${i}_-`, "v"]));
  assert.deepEqual(shapeSnsNotice({ subject: "s", body: "b", attributes: ten }).attributes, ten);
});
