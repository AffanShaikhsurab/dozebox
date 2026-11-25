import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ageMs, HOUR, parseInstant, toInstant } from "../src/time/index.ts";

const T0 = Date.UTC(2026, 10, 24, 21, 0, 0, 5);

test("toInstant and parseInstant round-trip with millisecond precision", () => {
  assert.equal(toInstant(T0), "2026-11-24T21:00:00.005Z");
  assert.equal(parseInstant(toInstant(T0)), T0);
  assert.equal(parseInstant("2026-11-24T21:00:00Z"), T0 - 5);
});

test("parseInstant refuses what is not an Instant", () => {
  for (const v of ["2026-11-24T21:00:00+01:00", "2026-11-24", "", 5, null, "2026-13-45T99:99:99Z"]) {
    assert.equal(parseInstant(v), null, String(v));
  }
});

test("ageMs is null without a time and never negative", () => {
  assert.equal(ageMs(T0, null), null);
  assert.equal(ageMs(T0, T0 - HOUR), HOUR);
  assert.equal(ageMs(T0, T0 + 1_000), 0);
});
