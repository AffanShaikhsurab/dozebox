import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const pkg = join(import.meta.dirname, "..");
const script = join(pkg, "scripts", "gen-schema.ts");
const docs = join(pkg, "..", "..", "docs", "reference", "protocol-v1.md");

function check(out: string, docsFile: string): number | null {
  return spawnSync(process.execPath, [script, "--check", "--out", out, "--docs", docsFile], { stdio: "pipe" }).status;
}

function copy(t: { after: (fn: () => void) => void }): { out: string; docsFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "dz-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "v1");
  cpSync(join(pkg, "schema", "v1"), out, { recursive: true });
  const docsFile = join(dir, "protocol-v1.md");
  cpSync(docs, docsFile);
  return { out, docsFile };
}

test("gen:schema --check passes on the committed files", (t) => {
  const { out, docsFile } = copy(t);
  assert.equal(check(out, docsFile), 0);
});

test("gen:schema --check fails on a hand edit of a schema file", (t) => {
  const { out, docsFile } = copy(t);
  const file = join(out, "hold-input.json");
  writeFileSync(file, readFileSync(file, "utf8").replace('"maxLength": 120', '"maxLength": 121'));
  assert.equal(check(out, docsFile), 1);
});

test("gen:schema --check fails on a stale extra file and on a docs edit", (t) => {
  const { out, docsFile } = copy(t);
  writeFileSync(join(out, "removed-type.json"), "{}\n");
  assert.equal(check(out, docsFile), 1);
  rmSync(join(out, "removed-type.json"));
  writeFileSync(docsFile, readFileSync(docsFile, "utf8") + "\nhand edit\n");
  assert.equal(check(out, docsFile), 1);
});
