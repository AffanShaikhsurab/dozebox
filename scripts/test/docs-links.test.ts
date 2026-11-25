import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { anchorsOf, checkLinks, slugOf } from "../docs/check-links.ts";

function repo(t: TestContext, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "dz-links-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("links that resolve pass: files, directories, anchors, other pages and external URLs", (t) => {
  const root = repo(t, {
    "README.md":
      "# Dozebox\n\n[start](docs/quickstart.md#from-zero) [dir](docs/decisions) [web](https://example.com/x#y)\n",
    "docs/quickstart.md":
      "# Quickstart\n\n## From zero\n\n[self](#from-zero) [up](../README.md#dozebox) [root](/README.md)\n",
    "docs/decisions/README.md": "# Decisions\n",
  });
  assert.deepEqual(checkLinks(root), []);
});

test("a link to a missing file fails with the file and line", (t) => {
  const root = repo(t, { "README.md": "# Dozebox\n\nSee [the guide](docs/missing.md).\n", "docs/a.md": "# A\n" });
  assert.deepEqual(checkLinks(root), [{ file: "README.md", line: 3, link: "docs/missing.md", reason: "no such file" }]);
});

test("a link to a heading that does not exist fails, in this page and in another", (t) => {
  const root = repo(t, {
    "README.md": "# Dozebox\n\n[x](docs/a.md#nope)\n",
    "docs/a.md": "# A\n\n[y](#also-nope)\n",
  });
  assert.deepEqual(
    checkLinks(root).map((p) => `${p.file}:${p.line} ${p.reason}`),
    ["README.md:3 no heading with the anchor #nope", "docs/a.md:3 no heading with the anchor #also-nope"],
  );
});

test("links inside code blocks and inline code are not checked", (t) => {
  const root = repo(t, {
    "README.md": "# Dozebox\n\n```md\n[gone](nowhere.md)\n```\n\nUse `[gone](nowhere.md)` as an example.\n",
  });
  assert.deepEqual(checkLinks(root), []);
});

test("a link that leaves the repository fails", (t) => {
  const root = repo(t, { "README.md": "[out](../outside.md)\n" });
  assert.equal(checkLinks(root)[0]?.reason, "points outside the repository");
});

test("anchors follow GitHub's rules: punctuation dropped, repeats numbered, code kept as text", () => {
  assert.equal(slugOf("`dozebox status`"), "dozebox-status");
  assert.equal(slugOf("Control API (v1)"), "control-api-v1");
  assert.equal(slugOf("Move a box: AZ & more"), "move-a-box-az--more");
  assert.deepEqual([...anchorsOf("# A\n\n## Same\n\n## Same\n\n```\n# not a heading\n```\n")], ["a", "same", "same-1"]);
});

test("the repository's own links resolve", () => {
  assert.deepEqual(checkLinks(process.cwd()), []);
});
