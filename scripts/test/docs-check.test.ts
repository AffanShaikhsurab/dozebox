import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkDocs } from "../docs/check.ts";

test("docs:check passes on the repository: links, reference tables, quickstart", async () => {
  const checks = await checkDocs(process.cwd());
  assert.deepEqual(
    checks.map((c) => c.name),
    ["links", "reference", "quickstart", "readme-quickstart", "quickstart-hcl"],
  );
  assert.deepEqual(
    checks.flatMap((c) => c.problems),
    [],
  );
});
