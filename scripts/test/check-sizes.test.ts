import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkSizes, NESTED_AGENTS_MAX, ROOT_AGENTS_MAX } from "../check-sizes.ts";

test("check-sizes enforces the root and nested AGENTS.md budgets", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dz-sizes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "packages", "core"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "x".repeat(ROOT_AGENTS_MAX));
  writeFileSync(join(root, "packages", "core", "AGENTS.md"), "x".repeat(NESTED_AGENTS_MAX + 1));
  assert.deepEqual(checkSizes(root), [
    { file: "packages/core/AGENTS.md", bytes: NESTED_AGENTS_MAX + 1, max: NESTED_AGENTS_MAX },
  ]);
});

test("the repository itself is within budget", () => {
  assert.deepEqual(checkSizes(process.cwd()), []);
});
