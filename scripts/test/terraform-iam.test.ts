import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Static checks over terraform/*.tf that terraform test cannot express: it has no way to list resources by type.
const dir = join(process.cwd(), "terraform");
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".tf"))
  .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));

function resourceNames(type: string): string[] {
  const re = new RegExp(`^resource\\s+"${type}"\\s+"([A-Za-z0-9_-]+)"`, "gm");
  return sources.flatMap(({ text }) => [...text.matchAll(re)].map((m) => m[1] ?? ""));
}

test("no inline role policy anywhere in the module (the I-13 lesson)", () => {
  assert.deepEqual(resourceNames("aws_iam_role_policy"), []);
  for (const { file, text } of sources) {
    assert.doesNotMatch(text, /^\s*inline_policy\s*\{/m, `${file} declares an inline_policy block`);
  }
});

test("every aws_iam_policy is listed in iam_index.tf", () => {
  const index = sources.find((s) => s.file === "iam_index.tf");
  assert.ok(index, "terraform/iam_index.tf is missing");
  const missing = resourceNames("aws_iam_policy").filter(
    (name) => !new RegExp(`=\\s*aws_iam_policy\\.${name}\\b`).test(index.text),
  );
  assert.deepEqual(missing, [], `add these to local.all_policies in iam_index.tf: ${missing.join(", ")}`);
});


test("no Elastic IP: a parked box must not hold a billed public address", () => {
  assert.deepEqual(resourceNames("aws_eip"), []);
});

test("the guarded data volume keeps prevent_destroy", () => {
  const volume = sources.find((s) => s.file === "volume.tf");
  assert.ok(volume, "terraform/volume.tf is missing");
  const block = /^resource\s+"aws_ebs_volume"\s+"data"\s+\{[\s\S]*?^\}/m.exec(volume.text)?.[0] ?? "";
  assert.match(block, /prevent_destroy\s*=\s*true/);
});
