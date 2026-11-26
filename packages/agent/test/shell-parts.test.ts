// The small shell modules: env, identity, log, errors, the record publisher, the SSM reader, the AWS composition.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SSMClient } from "@aws-sdk/client-ssm";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeClock, makeFakeFs } from "@dozebox/testkit/fakes";
import { offlineConfig, sdkError, ssmMemory } from "@dozebox/testkit/wire";
import { makeAwsPorts } from "../src/adapters/aws/compose.ts";
import { makeAwsParameterReader } from "../src/adapters/aws/ssm.ts";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";
import { makeJsonLogger } from "../src/adapters/log.ts";
import { readEnv } from "../src/env.ts";
import { makeErrorLog } from "../src/errors.ts";
import { BOOT_ID_PATH, resolveIdentity, writerOf } from "../src/identity.ts";
import { makeRecordPublisher } from "../src/records/publish.ts";
import { IDENTITY } from "./support.ts";

test("env: defaults, systemd's variables, and refusals", () => {
  assert.deepEqual(readEnv({ DOZEBOX_BOX_ID: "box-1" }, 42), {
    boxId: "box-1",
    prefix: "dozebox",
    region: null,
    stateDir: "/data/dozebox",
    imdsUrl: "http://169.254.169.254",
    notifySocket: undefined,
    watchdogEveryMs: null,
  });
  const full = readEnv(
    {
      DOZEBOX_BOX_ID: "main",
      DOZEBOX_PREFIX: "acme",
      DOZEBOX_REGION: "eu-west-2",
      DOZEBOX_STATE_DIR: "/var/lib/dozebox",
      DOZEBOX_IMDS_URL: "http://127.0.0.1:9999",
      NOTIFY_SOCKET: "/run/systemd/notify",
      WATCHDOG_USEC: "60000000",
      WATCHDOG_PID: "42",
    },
    42,
  );
  assert.equal(full.watchdogEveryMs, 30_000);
  assert.equal(full.region, "eu-west-2");
  assert.equal(
    readEnv({ DOZEBOX_BOX_ID: "b", WATCHDOG_USEC: "60000000", WATCHDOG_PID: "7" }, 42).watchdogEveryMs,
    null,
  );
  assert.throws(() => readEnv({}, 1), /DOZEBOX_BOX_ID is not set/);
  assert.throws(() => readEnv({ DOZEBOX_BOX_ID: "Box_1" }, 1), /DOZEBOX_BOX_ID="Box_1"/);
  assert.throws(() => readEnv({ DOZEBOX_BOX_ID: "b", DOZEBOX_STATE_DIR: "relative" }, 1), /DOZEBOX_STATE_DIR/);
  assert.throws(() => readEnv({ DOZEBOX_BOX_ID: "b", WATCHDOG_USEC: "soon" }, 1), /WATCHDOG_USEC/);
});

test("identity: IMDS facts, the boot id without dashes, the box root; region from env wins", async () => {
  const fake = makeFakeFs({ [BOOT_ID_PATH]: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n" });
  const files = makeNodeFiles(fake.fs.promises as unknown as FsPromises, 1);
  const imds = {
    instance: async () => ({
      instanceId: IDENTITY.instanceId,
      region: "us-east-1",
      availabilityZone: "us-east-1a",
      instanceType: "t4g.small",
      lifecycle: "spot" as const,
    }),
  };
  const env = readEnv({ DOZEBOX_BOX_ID: "box-1" }, 1);
  assert.deepEqual(await resolveIdentity(env, { imds, files }), IDENTITY);
  assert.equal((await resolveIdentity({ ...env, region: "us-west-2" }, { imds, files })).region, "us-west-2");
  assert.deepEqual(writerOf(IDENTITY), { instanceId: IDENTITY.instanceId, bootId: IDENTITY.bootId });
  const none = makeNodeFiles(makeFakeFs().fs.promises as unknown as FsPromises, 1);
  await assert.rejects(resolveIdentity(env, { imds, files: none }), /no boot id/);
});

test("log: one JSON line with ts, level, msg, the base and child fields; errors flattened", () => {
  const lines: string[] = [];
  const log = makeJsonLogger(
    (l) => lines.push(l),
    () => 0,
    { box: "box-1" },
  ).child({ component: "config" });
  log.log("warn", "hello", { error: new RunnerError("aws_throttled", true, "slow"), n: 1 });
  log.log("error", "bug", { error: new TypeError("boom") });
  assert.ok(lines.every((l) => l.endsWith("\n") && !l.slice(0, -1).includes("\n")));
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    ts: "1970-01-01T00:00:00.000Z",
    level: "warn",
    msg: "hello",
    box: "box-1",
    component: "config",
    error: { name: "RunnerError", code: "aws_throttled", message: "slow" },
    n: 1,
  });
  assert.match(JSON.parse(lines[1] ?? "").error.stack, /TypeError: boom/);
});

test("errors: bounded, newest last, messages cut to 1000", () => {
  const clock = makeFakeClock(0);
  const errors = makeErrorLog(clock.now, 3);
  for (const e of [new Error("a"), "b", { c: 1 }, new Error("x".repeat(2000))]) errors.add("s", e);
  assert.deepEqual(
    errors.recent(2).map((e) => e.message.length),
    [7, 1000],
  );
  assert.deepEqual(
    errors.recent(10).map((e) => e.message.slice(0, 7)),
    ["b", '{"c":1}', "x".repeat(7)],
  );
});

test("records: stamped with v, at and the writer tag, checked by schema, last-error cut and source checked", async () => {
  const puts: Array<{ name: string; value: string; tier: string }> = [];
  const writer = {
    put: async (name: string, value: string, o: { tier: string }) => void puts.push({ name, value, tier: o.tier }),
    delete: async () => {},
  };
  const pub = makeRecordPublisher({
    writer,
    clock: makeFakeClock(Date.parse("2026-11-25T01:02:03.000Z")),
    tag: writerOf(IDENTITY),
  });
  await pub.lastError("boot:attach", "y".repeat(1500));
  assert.equal(puts[0]?.name, "rec/last-error");
  assert.equal(puts[0]?.tier, "Standard");
  const rec = JSON.parse(puts[0]?.value ?? "");
  assert.equal(rec.v, 1);
  assert.equal(rec.at, "2026-11-25T01:02:03.000Z");
  assert.deepEqual(rec.writer, writerOf(IDENTITY));
  assert.equal(rec.message.length, 1000);
  assert.throws(() => pub.lastError("Config", "x"), /not an error source/);
  await pub.put("rec/serving", { payload: "web" });
  assert.equal(JSON.parse(puts[1]?.value ?? "").payload, "web");
  // @ts-expect-error: a body missing its fields does not type-check, and is refused at run time too.
  await assert.rejects(pub.put("rec/serving", {}), /does not match its schema/);
});

test("parameter reader: GetParameter under the root; missing is null; other errors are mapped", async () => {
  const ssm = new SSMClient(offlineConfig);
  const mem = ssmMemory(ssm, () => 0);
  mem.parameters.set("/dozebox/box-1/config", { value: "{}", type: "String", tier: "Standard", modifiedAt: 0 });
  const reader = makeAwsParameterReader({ ssm, root: "/dozebox/box-1/" });
  assert.equal(await reader.get("config"), "{}");
  assert.equal(await reader.get("payloads/web"), null);
  assert.deepEqual(mem.stub.inputs("GetParameterCommand"), [
    { Name: "/dozebox/box-1/config" },
    { Name: "/dozebox/box-1/payloads/web" },
  ]);
  mem.stub.fail("GetParameterCommand", "AccessDeniedException", 400);
  await assert.rejects(reader.get("config"), (e) => e instanceof RunnerError && e.code === "aws_denied");
  await assert.rejects(reader.get("../x"), (e) => e instanceof RunnerError && e.code === "invalid_input");
  assert.throws(() => makeAwsParameterReader({ ssm, root: "dozebox/box-1" }), /not a parameter root/);
  assert.ok(sdkError("x", 400) instanceof Error);
});

test("AWS composition: every port, the notifier per topic, no call at build time", () => {
  const ports = makeAwsPorts({ region: "us-east-1", root: "/dozebox/box-1/", prefix: "dozebox" });
  assert.deepEqual(Object.keys(ports).toSorted(), [
    "logs",
    "notifierFor",
    "params",
    "recordWriter",
    "secrets",
    "selfStop",
    "volumes",
  ]);
  assert.equal(typeof ports.notifierFor("arn:aws:sns:us-east-1:111122223333:t").publish, "function");
  assert.throws(() => makeAwsPorts({ region: "us-east-1", root: "/bad", prefix: "dozebox" }), /not a parameter root/);
});
