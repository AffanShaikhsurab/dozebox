import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { LastErrorRecord, LivenessRecord, WakesRecord } from "@dozebox/protocol/records";
import { RunnerError } from "../src/errors.ts";
import { byteLength, encodeRecord, readRecord, RECORD_LIMIT_BYTES, RECORD_SPECS } from "../src/records/index.ts";

const writer = { instanceId: "i-0123456789abcdef0", bootId: "boot-0001" };
const at = "2026-11-24T21:00:00.000Z";

const liveness = (over: Partial<LivenessRecord> = {}): LivenessRecord => ({
  v: 1,
  at,
  writer,
  agent: { version: "0.1.0", ok: true, strikes: 0 },
  payloads: [
    {
      name: "app",
      health: "ok",
      restartsThisHour: 0,
      lastProgressAt: at,
      progress: { build: at },
      holds: { work: 1, wait: 0, until: null, reasons: ["running"] },
    },
  ],
  presence: { interactiveUntil: null, lastInteractiveAt: null },
  idle: { since: null, sleepAt: null },
  net: { ok: true, downSince: null },
  disk: { level: "ok", freePct: 50 },
  undelivered: [],
  ...over,
});

const wakes = (n: number, reasonSize = 10): WakesRecord => ({
  v: 1,
  at,
  writer,
  atPark: true,
  wakes: Array.from({ length: n }, (_, i) => ({
    payload: "app",
    id: `w${i}`,
    reason: "r".repeat(reasonSize),
    expiresAt: at,
  })),
});

const lastError = (message: string): LastErrorRecord => ({ v: 1, at, writer, source: "boot:attach", message });

// readRecord

const readRows: ReadonlyArray<{
  name: string;
  raw: string | null;
  inService: { instanceId: string; bootId?: string } | null;
  expect: string;
}> = [
  { name: "absent parameter -> missing", raw: null, inService: null, expect: "missing:absent" },
  { name: "not JSON -> missing", raw: "{oops", inService: null, expect: "missing:not-json" },
  { name: "JSON but not an object -> invalid", raw: "42", inService: null, expect: "missing:invalid" },
  { name: "null JSON -> invalid", raw: "null", inService: null, expect: "missing:invalid" },
  { name: "unknown v -> missing", raw: JSON.stringify({ ...lastError("x"), v: 2, more: 1 }), inService: null, expect: "missing:unknown-version" },
  { name: "v as text -> invalid", raw: JSON.stringify({ ...lastError("x"), v: "2" }), inService: null, expect: "missing:invalid" },
  { name: "older shape (v 0) -> invalid", raw: JSON.stringify({ ...lastError("x"), v: 0 }), inService: null, expect: "missing:invalid" },
  { name: "unknown field (a later minor) -> ok", raw: JSON.stringify({ ...lastError("x"), extra: true }), inService: null, expect: "ok" },
  { name: "wrong field type -> invalid", raw: JSON.stringify({ ...lastError("x"), message: 5 }), inService: null, expect: "missing:invalid" },
  { name: "valid, nothing in service -> ok", raw: JSON.stringify(lastError("x")), inService: null, expect: "ok" },
  { name: "valid, right instance -> ok", raw: JSON.stringify(lastError("x")), inService: { instanceId: writer.instanceId }, expect: "ok" },
  {
    name: "valid, right instance and boot -> ok",
    raw: JSON.stringify(lastError("x")),
    inService: { instanceId: writer.instanceId, bootId: writer.bootId },
    expect: "ok",
  },
  {
    name: "wrong writer instance -> ignored",
    raw: JSON.stringify(lastError("x")),
    inService: { instanceId: "i-0fedcba9876543210" },
    expect: "ignored:wrong-writer",
  },
  {
    name: "same instance, older boot -> ignored",
    raw: JSON.stringify(lastError("x")),
    inService: { instanceId: writer.instanceId, bootId: "boot-0002" },
    expect: "ignored:wrong-writer",
  },
];

for (const row of readRows) {
  test(`readRecord: ${row.name}`, () => {
    const r = readRecord("rec/last-error", row.raw, row.inService);
    assert.equal(r.kind === "ok" ? "ok" : `${r.kind}:${r.why}`, row.expect);
  });
}

test("readRecord returns the record and the writer it ignored", () => {
  const ok = readRecord("rec/liveness", JSON.stringify(liveness()), null);
  assert.equal(ok.kind, "ok");
  if (ok.kind === "ok") assert.equal(ok.record.agent.version, "0.1.0");
  const ignored = readRecord("rec/last-error", JSON.stringify(lastError("x")), { instanceId: "i-0fedcba9876543210" });
  assert.deepEqual(ignored, { kind: "ignored", why: "wrong-writer", writer });
});

// encodeRecord

test("encodeRecord: a small record is written as is, in its tier", () => {
  const e = encodeRecord("rec/last-error", lastError("attach failed"));
  assert.deepEqual([e.tier, e.truncated, e.bytes], ["Standard", false, byteLength(e.value)]);
  assert.deepEqual(JSON.parse(e.value), lastError("attach failed"));
  assert.equal(encodeRecord("rec/liveness", liveness()).tier, "Advanced");
});

test("encodeRecord: an invalid record is refused before any write", () => {
  const bad = { ...lastError("x"), source: "Not Valid" };
  assert.throws(
    () => encodeRecord("rec/last-error", bad),
    (e: unknown) => e instanceof RunnerError && e.code === "invalid_input",
  );
});

test("encodeRecord: oversize wakes -> trimmed from the oldest end with truncated: true", () => {
  const big = wakes(20, 600);
  assert.ok(byteLength(JSON.stringify(big)) > RECORD_LIMIT_BYTES.Advanced);
  const e = encodeRecord("rec/wakes", big);
  const out = JSON.parse(e.value) as WakesRecord;
  assert.equal(e.truncated, true);
  assert.equal(out.truncated, true);
  assert.ok(e.bytes <= RECORD_LIMIT_BYTES.Advanced);
  assert.equal(out.wakes.at(-1)?.id, "w19", "the newest wake stays");
  assert.ok(out.wakes.length < 20 && out.wakes[0]?.id !== "w0", "the oldest wakes went first");
});

test("encodeRecord: oversize liveness drops undelivered, then hold reasons, then the oldest progress", () => {
  const big = (long: string, progress: Record<string, string>, reasons: string[]) =>
    liveness({
      undelivered: [
        { key: "old", severity: "page", title: long, at },
        { key: "new", severity: "page", title: long, at },
      ],
      payloads: [
        {
          name: "app",
          health: "ok",
          restartsThisHour: 0,
          lastProgressAt: at,
          progress,
          holds: { work: 1, wait: 0, until: null, reasons },
        },
      ],
    });
  const l = "x".repeat(4000);
  const first = big("u".repeat(500), { a: at }, [`newest${l}`, `oldest${l}`]);
  assert.ok(byteLength(JSON.stringify(first)) > RECORD_LIMIT_BYTES.Advanced);
  const out = JSON.parse(encodeRecord("rec/liveness", first).value) as LivenessRecord;
  assert.equal(out.truncated, true);
  assert.deepEqual(out.undelivered, []);
  assert.deepEqual(out.payloads[0]?.holds.reasons, [`newest${l}`], "the oldest reason (last) went");
  assert.deepEqual(Object.keys(out.payloads[0]?.progress ?? {}), ["a"]);

  const p = "p".repeat(5000);
  const second = big("t", { [`b${p}`]: at, [`a${p}`]: "2026-11-24T20:00:00.000Z" }, []);
  const out2 = JSON.parse(encodeRecord("rec/liveness", second).value) as LivenessRecord;
  assert.deepEqual(Object.keys(out2.payloads[0]?.progress ?? {}), [`b${p}`], "the oldest beat went");
});

test("encodeRecord: trimming touches only the payload that has something to drop", () => {
  const quiet = {
    name: "quiet",
    health: "ok" as const,
    restartsThisHour: 0,
    lastProgressAt: null,
    progress: {},
    holds: { work: 0, wait: 0, until: null, reasons: [] },
  };
  const l = "y".repeat(5000);
  const busy = { ...quiet, name: "busy", progress: { [`a${l}`]: at, [`b${l}`]: at }, holds: { ...quiet.holds, reasons: [l, l] } };
  const out = JSON.parse(encodeRecord("rec/liveness", liveness({ payloads: [quiet, busy] })).value) as LivenessRecord;
  assert.deepEqual(out.payloads[0], quiet);
  assert.deepEqual(out.payloads[1]?.holds.reasons, []);
  assert.equal(Object.keys(out.payloads[1]?.progress ?? {}).length, 1);
});

test("encodeRecord: liveness with nothing left to trim, or a record without lists, is refused when too big", () => {
  const huge = liveness({
    payloads: [
      {
        name: "n".repeat(9000),
        health: "ok",
        restartsThisHour: 0,
        lastProgressAt: null,
        progress: {},
        holds: { work: 0, wait: 0, until: null, reasons: [] },
      },
    ],
  });
  assert.throws(() => encodeRecord("rec/liveness", huge), /over the Advanced limit of 8192/);
  // 1000 four-byte characters: within the schema's maxLength, over the Standard tier's 4096 bytes.
  assert.throws(
    () => encodeRecord("rec/last-error", lastError("😀".repeat(1000))),
    (e: unknown) => e instanceof RunnerError && e.code === "invalid_input" && /Standard limit of 4096/.test(e.message),
  );
  assert.equal(RECORD_SPECS["rec/wakes"].trim?.(wakes(0)), null, "an empty wake list has nothing left to drop");
});

test("every record name has a spec, and only liveness and wakes are Advanced", () => {
  const advanced = Object.entries(RECORD_SPECS)
    .filter(([, s]) => s.tier === "Advanced")
    .map(([n]) => n);
  assert.deepEqual(advanced, ["rec/liveness", "rec/wakes"]);
});
