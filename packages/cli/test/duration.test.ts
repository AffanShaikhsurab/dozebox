import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DozeboxCliError } from "../src/command.ts";
import { parseDuration } from "../src/duration.ts";

describe("parseDuration", () => {
  for (const [text, ms] of [
    ["90s", 90_000],
    ["15m", 900_000],
    ["2h", 7_200_000],
    ["1h30m", 5_400_000],
    ["1h2m3s", 3_723_000],
    ["0h5m", 300_000],
  ] as const) {
    it(`${text} -> ${ms}`, () => assert.equal(parseDuration(text), ms));
  }

  for (const text of ["", "0s", "5", "m5", "1.5h", "-5m", "5M", "5m1h", "1h 30m", "abc"]) {
    it(`rejects "${text}"`, () => {
      assert.throws(
        () => parseDuration(text),
        (e: unknown) => e instanceof DozeboxCliError && e.code === "usage",
      );
    });
  }
});
