import { strict as assert } from "node:assert";
import { test } from "node:test";
import Value from "typebox/value";
import { SCHEMAS } from "../src/registry.ts";
import { SAMPLES } from "./samples.ts";

test("every schema in the registry has a sample", () => {
  assert.deepEqual(
    SCHEMAS.map((s) => s.title).filter((t) => !(t in SAMPLES)),
    [],
  );
  assert.deepEqual(
    Object.keys(SAMPLES).filter((t) => !SCHEMAS.some((s) => s.title === t)),
    [],
  );
});

for (const { title, schema } of SCHEMAS) {
  const sample = SAMPLES[title];
  test(`${title} accepts a valid value and rejects one with ${sample?.why ?? "?"}`, () => {
    assert.ok(sample);
    assert.ok(
      Value.Check(schema, sample.valid),
      [...Value.Errors(schema, sample.valid)].map((e) => e.message).join(", "),
    );
    assert.equal(Value.Check(schema, sample.invalid), false);
  });
}

test("request schemas reject unknown fields; response schemas tolerate them", () => {
  const requests = [
    "HoldInput",
    "BeatsInput",
    "WakeInput",
    "PresenceInput",
    "AttentionInput",
    "HealthInput",
    "SleepInput",
  ];
  const responses = [
    "Hello",
    "Hold",
    "Wake",
    "Presence",
    "Status",
    "AttentionAccepted",
    "SleepAccepted",
    "ControlStatus",
    "ControlAnswer",
    "ControlErrorBody",
  ];
  for (const { title, schema } of SCHEMAS) {
    const valid = SAMPLES[title]?.valid as Record<string, unknown>;
    const extra = { ...valid, addedInALaterMinor: true };
    if (requests.includes(title)) assert.equal(Value.Check(schema, extra), false, `${title} accepted an unknown field`);
    if (responses.includes(title)) assert.ok(Value.Check(schema, extra), `${title} rejected an unknown field`);
  }
});

test("instants need UTC with a trailing Z", () => {
  const holdInput = SCHEMAS.find((s) => s.title === "HoldInput")?.schema;
  assert.ok(holdInput);
  assert.equal(Value.Check(holdInput, { reason: "r", until: "2026-11-24T21:00:00+05:30" }), false);
  assert.ok(Value.Check(holdInput, { reason: "r", until: "2026-11-24T21:00:00Z" }));
});
