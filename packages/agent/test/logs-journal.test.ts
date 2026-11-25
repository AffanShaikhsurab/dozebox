// makeJournalReader: journalctl argv, lenient parsing, microsecond timestamps, cursors, failure.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeExec } from "@dozebox/testkit/fakes";
import { makeJournalReader } from "../src/logs/journal.ts";

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const entry = (n: number, message: unknown = `m${n}`) =>
  line({ __CURSOR: `c${n}`, __REALTIME_TIMESTAMP: String(n * 1_000_000), MESSAGE: message });

test("runs journalctl for this boot, with the cursor and units when given", async () => {
  const exec = makeFakeExec([{ match: ["journalctl"], outcome: { stdout: "" } }]);
  const read = makeJournalReader({ exec, units: ["dozebox-agent", "ssh"] });
  await read(null, 10);
  await read("c9", 10);
  assert.deepEqual(exec.calls[0]?.argv, [
    "journalctl",
    "-o",
    "json",
    "--no-pager",
    "-b",
    "-u",
    "dozebox-agent",
    "-u",
    "ssh",
  ]);
  assert.deepEqual(exec.calls[1]?.argv.slice(0, 6), [
    "journalctl",
    "-o",
    "json",
    "--no-pager",
    "-b",
    "--after-cursor=c9",
  ]);
});

test("parses entries: microseconds to milliseconds, last cursor", async () => {
  const exec = makeFakeExec([{ match: ["journalctl"], outcome: { stdout: [entry(1), entry(2)].join("\n") + "\n" } }]);
  const r = await makeJournalReader({ exec })(null, 10);
  assert.deepEqual(r.events, [
    { at: 1_000, message: "m1" },
    { at: 2_000, message: "m2" },
  ]);
  assert.equal(r.cursor, "c2");
});

test("takes the first max entries and returns the cursor of the last one taken", async () => {
  const stdout = [1, 2, 3, 4].map((n) => entry(n)).join("\n");
  const exec = makeFakeExec([{ match: ["journalctl"], outcome: { stdout } }]);
  const r = await makeJournalReader({ exec })("c0", 2);
  assert.deepEqual(
    r.events.map((e) => e.message),
    ["m1", "m2"],
  );
  assert.equal(r.cursor, "c2");
});

test("skips malformed lines and entries with an unusable message", async () => {
  const stdout = [
    "not json",
    "",
    "[1,2]",
    entry(1, { nested: true }),
    entry(2, [104, 105, 0xe2, 0x82, 0xac]),
    entry(3, [300]),
    line({ __CURSOR: "c4", MESSAGE: "no timestamp" }),
    entry(5),
  ].join("\n");
  const exec = makeFakeExec([{ match: ["journalctl"], outcome: { stdout } }]);
  const r = await makeJournalReader({ exec })(null, 10);
  assert.deepEqual(r.events, [
    { at: 2_000, message: "hi\u20ac" },
    { at: 5_000, message: "m5" },
  ]);
  assert.equal(r.cursor, "c5");
});

test("no entries keeps the input cursor", async () => {
  const exec = makeFakeExec([{ match: ["journalctl"], outcome: { stdout: "" } }]);
  assert.deepEqual(await makeJournalReader({ exec })("c7", 5), { events: [], cursor: "c7" });
  assert.deepEqual(await makeJournalReader({ exec })(null, 5), { events: [], cursor: null });
});

test("a non-zero exit is a retryable internal error", async () => {
  const exec = makeFakeExec([{ match: ["journalctl"], outcome: { code: 1, stderr: "boom" } }]);
  await assert.rejects(makeJournalReader({ exec })(null, 5), (e: unknown) => {
    assert.ok(e instanceof RunnerError);
    assert.equal(e.code, "internal");
    assert.equal(e.retryable, true);
    return true;
  });
});
