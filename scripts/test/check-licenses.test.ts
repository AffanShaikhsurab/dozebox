import { strict as assert } from "node:assert";
import { test } from "node:test";
import { allowed, checkLicenses, DEFAULT_ALLOW } from "../check-licenses.ts";

const allow = new Set(DEFAULT_ALLOW);

test("SPDX expressions: OR needs one allowed side, AND needs both", () => {
  assert.equal(allowed("MIT", allow), true);
  assert.equal(allowed("(MIT OR GPL-3.0)", allow), true);
  assert.equal(allowed("MIT AND GPL-3.0", allow), false);
  assert.equal(allowed("(MIT AND (Apache-2.0 OR GPL-2.0))", allow), true);
  assert.equal(allowed("GPL-3.0", allow), false);
  assert.equal(allowed("Unknown", allow), false);
  assert.equal(allowed("MIT GPL-3.0", allow), false);
});

test("checkLicenses reports each package outside the allowlist", () => {
  const json = {
    MIT: [{ name: "a", versions: ["1.0.0"], license: "MIT" }],
    "GPL-3.0": [{ name: "b", versions: ["2.0.0", "2.1.0"], license: "GPL-3.0" }],
    "(MIT OR GPL-3.0)": [{ name: "c", versions: ["3.0.0"], license: "(MIT OR GPL-3.0)" }],
    Unknown: [{ name: "d", versions: ["0.1.0"] }],
  };
  assert.deepEqual(checkLicenses(json, DEFAULT_ALLOW), [
    { name: "b", versions: "2.0.0, 2.1.0", license: "GPL-3.0" },
    { name: "d", versions: "0.1.0", license: "Unknown" },
  ]);
});

test("checkLicenses rejects input that is not pnpm's license map", () => {
  assert.throws(() => checkLicenses([], DEFAULT_ALLOW), /pnpm licenses JSON/);
});
