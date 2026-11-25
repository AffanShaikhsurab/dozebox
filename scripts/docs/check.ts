// `pnpm docs:check`: every relative link resolves, the generated reference tables are current, and every command in
// the quickstart runs against the fakes.
// Usage: node --conditions=@dozebox/source scripts/docs/check.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLinks } from "./check-links.ts";
import { checkReference } from "./gen-reference.ts";
import { runQuickstart } from "./run-quickstart.ts";

export type DocsCheck = { readonly name: string; readonly problems: ReadonlyArray<string> };

export async function checkDocs(root: string): Promise<ReadonlyArray<DocsCheck>> {
  const quickstart = await runQuickstart(readFileSync(join(root, "docs", "quickstart.md"), "utf8"));
  return [
    { name: "links", problems: checkLinks(root).map((p) => `${p.file}:${p.line}: ${p.link}: ${p.reason}`) },
    { name: "reference", problems: checkReference(root) },
    {
      name: "quickstart",
      problems: quickstart.filter((r) => r.problem !== null).map((r) => `${r.command}: ${r.problem}`),
    },
  ];
}

if (import.meta.main) {
  const checks = await checkDocs(join(import.meta.dirname, "..", ".."));
  for (const c of checks) {
    process.stdout.write(`${c.problems.length === 0 ? "ok  " : "FAIL"} ${c.name}\n`);
    for (const p of c.problems) process.stderr.write(`  ${p}\n`);
  }
  process.exitCode = checks.every((c) => c.problems.length === 0) ? 0 : 1;
}
