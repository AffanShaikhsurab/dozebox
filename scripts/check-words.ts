// No file under packages/ may name a payload or its maker (part 6 §6.1). Usage: node scripts/check-words.ts [root]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const FORBIDDEN = /nightshift|t3code|t3box|factory/i;
const SKIP_DIRS = new Set(["node_modules", "dist", "examples", ".terraform"]);
const SKIP_FILES = new Set(["CHANGELOG.md"]);

export type WordHit = { readonly file: string; readonly line: number; readonly text: string };

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(path);
    } else if (!SKIP_FILES.has(name)) {
      yield path;
    }
  }
}

export function findForbiddenWords(root: string): WordHit[] {
  const packagesDir = join(root, "packages");
  const hits: WordHit[] = [];
  let entries: Generator<string>;
  try {
    statSync(packagesDir);
    entries = walk(packagesDir);
  } catch {
    return hits;
  }
  for (const file of entries) {
    const rel = relative(root, file).split(sep).join("/");
    if (FORBIDDEN.test(rel)) hits.push({ file: rel, line: 0, text: "(file name)" });
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (FORBIDDEN.test(text)) hits.push({ file: rel, line: i + 1, text: text.trim().slice(0, 120) });
    });
  }
  return hits;
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const hits = findForbiddenWords(root);
  for (const h of hits) console.error(`${h.file}:${h.line}: forbidden word: ${h.text}`);
  if (hits.length > 0) {
    console.error(`check-words: ${hits.length} hit(s). Payload names belong in examples/ only.`);
    process.exit(1);
  }
  console.log("check-words: ok");
}
