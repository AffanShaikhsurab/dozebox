import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SHIM_COMMANDS } from "../../packages/agent/src/protocol/shim-commands.ts";
import { COMMANDS } from "../../packages/cli/src/commands/index.ts";
import {
  checkReference,
  CLI_REFERENCE,
  renderCliReference,
  renderTerraformReference,
  TERRAFORM_REFERENCE,
  writeReference,
} from "../docs/gen-reference.ts";
import { declarations, stringValue } from "../docs/hcl.ts";

const VARIABLES = `variable "box_id" {
  description = "Box id, used in names."
  type        = string
  default     = "main"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,19}$", var.box_id))
    error_message = "box_id must match ^[a-z0-9][a-z0-9-]{0,19}$."
  }
}

variable "caps" {
  description = "Hard limits | on spend."
  type = object({
    monthly_budget_usd = number # dollars
    freeze_on_budget   = optional(bool, true)
  })
}
`;

const OUTPUTS = `output "control_url" {
  description = "Base URL of the <control> API."
  value       = "https://\${local.host}/"
}
`;

function stack(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "dz-ref-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "terraform"), { recursive: true });
  writeFileSync(join(root, "terraform", "variables.tf"), VARIABLES);
  writeFileSync(join(root, "terraform", "outputs.tf"), OUTPUTS);
  return root;
}

test("the HCL reader finds variables, outputs, multi-line types and validation messages", () => {
  const found = declarations(VARIABLES + OUTPUTS);
  assert.deepEqual(
    found.map((d) => `${d.kind} ${d.name}`),
    ["variable box_id", "variable caps", "output control_url"],
  );
  const caps = found[1]?.items.find((i) => i.kind === "attr" && i.name === "type");
  assert.ok(caps?.kind === "attr" && caps.value.includes("freeze_on_budget") && caps.value.endsWith("})"));
  assert.equal(stringValue('"a \\"b\\""'), 'a "b"');
});

test("the Terraform reference lists inputs with defaults, required, rules and outputs", (t) => {
  const text = renderTerraformReference(stack(t));
  assert.match(text, /\| `box_id` \| `string` \| `"main"` \| no \| Box id, used in names\. \|/);
  assert.match(text, /\| `caps` \| `object \(see below\)` \| n\/a \| yes \| Hard limits \\\| on spend\. \|/);
  assert.match(text, /- `box_id`: box_id must match/);
  assert.match(text, /\| `control_url` \| Base URL of the &lt;control&gt; API\. \|/);
  assert.match(text, /### caps\n\n```hcl\nobject\(\{\n {2}monthly_budget_usd = number/);
});

test("the CLI reference lists every command, the box shim's two, and the exit codes", () => {
  const text = renderCliReference();
  for (const c of COMMANDS) assert.ok(text.includes(`\`dozebox ${c.name}\``), c.name);
  for (const c of SHIM_COMMANDS) assert.ok(text.includes(`### \`dozebox ${c.name}\``), c.name);
  assert.match(text, /## Box commands[\s\S]*## Operator-only commands/);
  assert.match(text, /## Operator-only commands[\s\S]*`dozebox status`/);
  assert.match(text, /\| 75 \| Try again later/);
  assert.match(text, /\| `--dry-run` \|/);
});

test("--check passes right after generating, and fails on a changed, edited or missing file", (t) => {
  const root = stack(t);
  assert.equal(checkReference(root).length, 2, "nothing generated yet: both files are missing");
  writeReference(root);
  assert.deepEqual(checkReference(root), []);

  writeFileSync(join(root, "terraform", "variables.tf"), VARIABLES.replace('"main"', '"other"'));
  assert.deepEqual(checkReference(root), [
    `${TERRAFORM_REFERENCE} is out of date; run \`node --conditions=@dozebox/source scripts/docs/gen-reference.ts\``,
  ]);
  writeReference(root);
  writeFileSync(join(root, CLI_REFERENCE), `${readFileSync(join(root, CLI_REFERENCE), "utf8")}\nhand edit\n`);
  assert.match(checkReference(root)[0] ?? "", /cli\.md is out of date/);
});

test("the committed reference files match the sources", () => {
  assert.deepEqual(checkReference(process.cwd()), []);
});
