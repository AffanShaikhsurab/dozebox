// `pnpm docs:check`: every relative link resolves, the generated reference tables are current, and every command in
// the quickstart and in the README quickstart runs against the fakes.
// Usage: node --conditions=@dozebox/source scripts/docs/check.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLinks } from "./check-links.ts";
import { checkReference } from "./gen-reference.ts";
import { declarations } from "./hcl.ts";
import { runQuickstart, type QuickstartResult } from "./run-quickstart.ts";

export type DocsCheck = { readonly name: string; readonly problems: ReadonlyArray<string> };

const problemsOf = (results: ReadonlyArray<QuickstartResult>): ReadonlyArray<string> =>
  results.filter((r) => r.problem !== null).map((r) => `${r.command}: ${r.problem}`);

/** The text of every ```hcl block. */
function hclBlocks(markdown: string): ReadonlyArray<string> {
  return [...markdown.matchAll(/^```hcl\r?\n([\s\S]*?)^```/gm)].map((m) => m[1] ?? "");
}

/** Brackets outside strings and comments that never close, or close without opening. */
function unbalanced(hcl: string): boolean {
  const open: string[] = [];
  for (const line of hcl.split("\n")) {
    const code = line.replace(/"(\\.|[^"\\])*"/g, '""').replace(/(#|\/\/).*$/, "");
    for (const c of code) {
      if ("{[(".includes(c)) open.push(c);
      else if ("}])".includes(c) && open.pop() === undefined) return true;
    }
  }
  return open.length > 0;
}

/** Small checks on the HCL a page tells the reader to write: balanced, a pinned module source, real module outputs. */
export function checkHcl(markdown: string, moduleOutputs: ReadonlySet<string>): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const block of hclBlocks(markdown)) {
    if (unbalanced(block)) problems.push("an hcl block has unbalanced brackets");
    for (const source of block.matchAll(/^\s*source\s*=\s*"(git::[^"]*)"/gm))
      if (!/\.git\/\/[\w/-]+\?ref=v\d+\.\d+\.\d+$/.test(source[1] ?? ""))
        problems.push(`module source is not a tagged Git source: ${source[1]}`);
    for (const m of block.matchAll(/value\s*=\s*module\.dozebox\.(\w+)/g))
      if (!moduleOutputs.has(m[1] ?? "")) problems.push(`output module.dozebox.${m[1]} does not exist`);
  }
  return problems;
}

export async function checkDocs(root: string): Promise<ReadonlyArray<DocsCheck>> {
  const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");
  const readme = read("README.md");
  const moduleOutputs = new Set(declarations(read("terraform", "outputs.tf")).map((d) => d.name));
  return [
    { name: "links", problems: checkLinks(root).map((p) => `${p.file}:${p.line}: ${p.link}: ${p.reason}`) },
    { name: "reference", problems: checkReference(root) },
    { name: "quickstart", problems: problemsOf(await runQuickstart(read("docs", "quickstart.md"))) },
    {
      name: "readme-quickstart",
      problems: [...problemsOf(await runQuickstart(readme)), ...checkHcl(readme, moduleOutputs)],
    },
    { name: "quickstart-hcl", problems: checkHcl(read("docs", "quickstart.md"), moduleOutputs) },
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
