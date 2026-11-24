// Size budgets (part 7 §7.8, part 5 §5.2). Usage: node scripts/check-sizes.ts [root]
// IAM policy sizes join here with the IAM package (WP-T2).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

export const ROOT_AGENTS_MAX: number = 6 * 1024;
export const NESTED_AGENTS_MAX: number = 4 * 1024;
export const USER_DATA_GZIP_MAX: number = 12_800;

export type SizeProblem = { readonly file: string; readonly bytes: number; readonly max: number };

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".terraform", "legacy"]);

function* agentsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* agentsFiles(path);
    } else if (name === "AGENTS.md") {
      yield path;
    }
  }
}

export function checkSizes(root: string): SizeProblem[] {
  const problems: SizeProblem[] = [];
  for (const file of agentsFiles(root)) {
    const rel = relative(root, file).split(sep).join("/");
    const bytes = statSync(file).size;
    const max = rel === "AGENTS.md" ? ROOT_AGENTS_MAX : NESTED_AGENTS_MAX;
    if (bytes > max) problems.push({ file: rel, bytes, max });
  }
  const userData = join(root, "box", "cloud-init.yaml.tftpl");
  if (existsSync(userData)) {
    const bytes = gzipSync(readFileSync(userData)).length;
    if (bytes > USER_DATA_GZIP_MAX)
      problems.push({ file: "box/cloud-init.yaml.tftpl (gzip)", bytes, max: USER_DATA_GZIP_MAX });
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkSizes(process.argv[2] ?? process.cwd());
  for (const p of problems) console.error(`${p.file}: ${p.bytes} bytes, budget ${p.max}`);
  if (problems.length > 0) process.exit(1);
  console.log("check-sizes: ok");
}
