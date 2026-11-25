// config/load.ts: the SSM copy when valid, else the last good copy, and rec/last-error source `config`.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { LastErrorRecord, matchesSchema } from "@dozebox/protocol/records";
import { lastGoodPath, makeConfigLoader } from "../src/config/load.ts";
import { boxConfig, harness, IDENTITY, payload, type Harness } from "./support.ts";

const loader = (h: Harness) =>
  makeConfigLoader({
    params: h.deps.params,
    files: h.files,
    records: h.deps.records,
    log: h.deps.log,
    identity: IDENTITY,
    stateDir: "/data/dozebox",
  });

const SAVED = lastGoodPath("/data/dozebox");
const savedText = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ box: boxConfig(over), payloads: [payload()] });

const lastError = (h: Harness) => {
  const text = h.records.get("rec/last-error");
  assert.ok(text, "rec/last-error was written");
  const rec: unknown = JSON.parse(text);
  assert.ok(matchesSchema(LastErrorRecord, rec), "rec/last-error matches its schema");
  return rec as LastErrorRecord;
};

test("a valid SSM config is used and saved as the last good copy", async () => {
  const h = harness();
  const cfg = await loader(h).load();
  assert.equal(cfg.from, "ssm");
  assert.equal(cfg.problem, null);
  assert.deepEqual(
    cfg.payloads.map((p) => p.name),
    ["web"],
  );
  assert.equal(SAVED, "/data/dozebox/config/last-good.json");
  assert.deepEqual(JSON.parse((await h.files.readText(SAVED)) ?? ""), { box: boxConfig(), payloads: [payload()] });
  assert.equal(h.records.has("rec/last-error"), false);
});

test("invalid config: keeps the last good copy from disk and writes rec/last-error source config", async () => {
  const h = harness({
    files: { [SAVED]: savedText({ idle: { idleMinutes: 45, viewingGraceMinutes: 10, noProgressParkMinutes: 150 } }) },
  });
  h.params.set("config", JSON.stringify(boxConfig({ idle: { idleMinutes: 1 } })));
  const cfg = await loader(h).load();
  assert.equal(cfg.from, "last-good");
  assert.equal(cfg.box.idle.idleMinutes, 45);
  const rec = lastError(h);
  assert.equal(rec.source, "config");
  assert.match(rec.message, /^config: \/idle/);
  assert.deepEqual(rec.writer, { instanceId: IDENTITY.instanceId, bootId: IDENTITY.bootId });
  assert.equal(cfg.problem, rec.message);
  // The saved copy is not replaced by the invalid one.
  assert.equal(JSON.parse((await h.files.readText(SAVED)) ?? "").box.idle.idleMinutes, 45);
});

test("invalid config at a reload keeps the config in memory; rec/last-error once per distinct problem", async () => {
  const h = harness();
  const l = loader(h);
  await l.load();
  h.params.set("config", "{not json");
  const a = await l.load();
  const b = await l.load();
  assert.equal(a.from, "last-good");
  assert.equal(b.box.idle.idleMinutes, 30);
  assert.equal(h.events.filter((e) => e === "put:rec/last-error").length, 1);
  assert.match(lastError(h).message, /^config: not JSON/);
  h.params.set("config", JSON.stringify(boxConfig({ payloads: ["web", "web"] })));
  await l.load();
  assert.equal(h.events.filter((e) => e === "put:rec/last-error").length, 2);
  assert.match(lastError(h).message, /listed twice/);
  // Valid again, then the first problem again: reported again.
  h.params.set("config", JSON.stringify(boxConfig()));
  assert.equal((await l.load()).from, "ssm");
  h.params.set("config", "{not json");
  await l.load();
  assert.equal(h.events.filter((e) => e === "put:rec/last-error").length, 3);
  assert.equal(l.current().from, "last-good");
});

test("invalid config and no last good copy: rec/last-error, then RunnerError invalid_input", async () => {
  const h = harness();
  h.params.delete("config");
  await assert.rejects(loader(h).load(), (e) => e instanceof RunnerError && e.code === "invalid_input");
  assert.match(lastError(h).message, /config: the parameter does not exist/);
  assert.equal(await h.files.readText(SAVED), null);
});

test("payload definitions are checked: missing, misnamed, reserved env", async () => {
  const cases: Array<[string | null, RegExp]> = [
    [null, /payloads\/web: the parameter does not exist/],
    [JSON.stringify(payload({ name: "api" })), /payloads\/web: the definition is named "api"/],
    [JSON.stringify(payload({ user: "root" })), /payloads\/web: \/user/],
    [
      JSON.stringify(payload({ start: { command: ["x"], env: { DOZEBOX_SOCKET: "/tmp/s" } } })),
      /may not set DOZEBOX_SOCKET/,
    ],
  ];
  for (const [text, problem] of cases) {
    const h = harness({ files: { [SAVED]: savedText() } });
    if (text === null) h.params.delete("payloads/web");
    else h.params.set("payloads/web", text);
    const cfg = await loader(h).load();
    assert.equal(cfg.from, "last-good");
    assert.match(lastError(h).message, problem);
  }
});

test("a config written for another box is invalid", async () => {
  const h = harness({ files: { [SAVED]: savedText() } });
  h.params.set("config", JSON.stringify(boxConfig({ box: { id: "box-2", prefix: "dozebox", region: "us-east-1" } })));
  assert.equal((await loader(h).load()).from, "last-good");
  assert.match(lastError(h).message, /written for dozebox\/box-2, this agent is dozebox\/box-1/);
});

test("SSM unreadable: the last good copy, logged, no rec/last-error (a later read may work)", async () => {
  const h = harness({ files: { [SAVED]: savedText() } });
  h.params.set("config", new RunnerError("aws_throttled", true, "ThrottlingException"));
  const cfg = await loader(h).load();
  assert.equal(cfg.from, "last-good");
  assert.match(cfg.problem ?? "", /SSM read failed: ThrottlingException/);
  assert.equal(h.records.has("rec/last-error"), false);
  assert.ok(h.lines.some((l) => l.includes("keeping the last good config")));
});

test("SSM unreadable and nothing saved: rec/last-error, then a rejection", async () => {
  const h = harness();
  h.params.set("config", new RunnerError("aws_unavailable", true, "connect ECONNREFUSED"));
  await assert.rejects(loader(h).load(), /no last good config to fall back to/);
  assert.match(lastError(h).message, /SSM read failed: connect ECONNREFUSED/);
});

test("a corrupt or foreign saved copy counts as none", async () => {
  for (const text of [
    "{",
    JSON.stringify({ box: boxConfig(), payloads: [] }),
    savedText({ box: { id: "box-9", prefix: "dozebox", region: "us-east-1" } }),
  ]) {
    const h = harness({ files: { [SAVED]: text } });
    h.params.set("config", "[]");
    await assert.rejects(loader(h).load(), /no last good config/);
  }
});

test("a failed rec/last-error write does not stop the fallback, and is retried at the next load", async () => {
  const h = harness({ files: { [SAVED]: savedText() } });
  h.params.set("config", "{");
  h.faults.put = new RunnerError("aws_throttled", true, "ThrottlingException");
  const l = loader(h);
  assert.equal((await l.load()).from, "last-good");
  assert.ok(h.lines.some((line) => line.includes("could not write rec/last-error")));
  h.faults.put = null;
  await l.load();
  assert.match(lastError(h).message, /not JSON/);
});

test("the saved copy is rewritten only when the config changed", async () => {
  const h = harness();
  let writes = 0;
  const files = { ...h.files, writeAtomic: async (p: string, t: string) => (writes++, h.files.writeAtomic(p, t)) };
  const l = makeConfigLoader({
    params: h.deps.params,
    files,
    records: h.deps.records,
    log: h.deps.log,
    identity: IDENTITY,
    stateDir: "/data/dozebox",
  });
  await l.load();
  await l.load();
  assert.equal(writes, 1);
  h.params.set("config", JSON.stringify(boxConfig({ caps: { awakeHoursPerDay: 8 } })));
  assert.equal((await l.load()).box.caps.awakeHoursPerDay, 8);
  assert.equal(writes, 2);
});

test("current() before the first load is a bug", () => {
  assert.throws(() => loader(harness()).current(), /before the first load/);
});
