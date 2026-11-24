import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeControlStatus } from "../src/control/v1.ts";
import { normalizeEvent, normalizeSeverity, normalizeStatus, ProtocolDecodeError } from "../src/v1/index.ts";

const fixtures = join(import.meta.dirname, "..", "..", "testkit", "fixtures", "protocol", "v1");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

test("a status from a later minor decodes: unknown phase reads as serving, extra fields are kept", () => {
  const status = normalizeStatus(fixture("status.future.json"));
  assert.equal(status.box.phase, "serving");
  assert.equal(status.holds[0]?.id, "run-42");
  assert.equal(status.caps.awakeSecondsCap, null);
});

test("normalizeStatus throws ProtocolDecodeError on a body that is not a status", () => {
  assert.throws(() => normalizeStatus({ box: { phase: "serving" } }), ProtocolDecodeError);
  assert.throws(() => normalizeStatus("serving"), ProtocolDecodeError);
});

test("a control status from a later version decodes with the documented fallbacks", () => {
  const status = normalizeControlStatus(fixture("control-status.future.json"));
  assert.equal(status.state, "running");
  assert.equal(status.alertPath.level, "info");
  assert.equal(status.summary.level, "ok");
  assert.equal(status.liveness?.payloads[0]?.health, "degraded");
});

test("normalizeControlStatus keeps known values and rejects a wrong record version", () => {
  const raw = fixture("control-status.future.json") as Record<string, unknown>;
  assert.equal(normalizeControlStatus({ ...raw, state: "parked" }).state, "parked");
  assert.throws(() => normalizeControlStatus({ ...raw, v: 2 }), ProtocolDecodeError);
});

const events = fixture("events.future.json") as Array<{
  event: string;
  data: unknown;
  expect: Record<string, unknown>;
}>;
for (const { event, data, expect } of events) {
  test(`event ${event} decodes to ${String(expect["type"])}`, () => {
    const decoded = normalizeEvent(event, data) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(expect)) assert.deepEqual(decoded[key], value);
  });
}

test("unknown severity reads as notify", () => {
  assert.equal(normalizeSeverity("page"), "page");
  assert.equal(normalizeSeverity("urgent"), "notify");
});
