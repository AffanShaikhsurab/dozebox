import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findForbiddenWords } from "../check-words.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dz-words-"));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

test("check-words fails on a file under packages/ that names a payload", (t) => {
  const root = fixture({ "packages/core/src/a.ts": "export const x = 1;\n// runs Nightshift\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hits = findForbiddenWords(root);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], { file: "packages/core/src/a.ts", line: 2, text: "// runs Nightshift" });
});

test("check-words ignores examples/, CHANGELOG.md and files outside packages/", (t) => {
  const root = fixture({
    "packages/cli/examples/n.json": '{"name":"nightshift"}',
    "packages/cli/CHANGELOG.md": "t3box compatibility",
    "docs/history.md": "imported from nightshift",
    "packages/cli/src/ok.ts": "export const ok = true;\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(findForbiddenWords(root), []);
});

test("check-words flags a forbidden file name", (t) => {
  const root = fixture({ "packages/core/src/t3box-names.ts": "export {};\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(findForbiddenWords(root)[0]?.text, "(file name)");
});

test("the repository itself is clean", () => {
  assert.deepEqual(findForbiddenWords(process.cwd()), []);
});
