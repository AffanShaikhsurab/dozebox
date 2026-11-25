// Checks every relative link and anchor in README.md and docs/**/*.md. External links are not fetched.
// Usage: node --conditions=@dozebox/source scripts/docs/check-links.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export type LinkProblem = {
  readonly file: string;
  readonly line: number;
  readonly link: string;
  readonly reason: string;
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".terraform", "legacy"]);
const LINK = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

function markdownFiles(root: string): ReadonlyArray<string> {
  const out: string[] = [];
  if (existsSync(join(root, "README.md"))) out.push(join(root, "README.md"));
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(path);
      } else if (name.endsWith(".md")) out.push(path);
    }
  };
  if (existsSync(join(root, "docs"))) walk(join(root, "docs"));
  return out;
}

/** The lines of a markdown file with fenced code blocks emptied (and inline code too when `inline`); numbers are kept. */
function proseLines(text: string, inline: boolean): ReadonlyArray<string> {
  let fence: string | null = null;
  return text.split(/\r?\n/).map((line) => {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (mark !== undefined && mark.startsWith(fence.slice(0, 3)) && mark.length >= fence.length) fence = null;
      return "";
    }
    if (mark !== undefined) {
      fence = mark;
      return "";
    }
    return inline ? line.replace(/`+[^`]*`+/g, "") : line;
  });
}

/** GitHub's heading anchor: lower case, punctuation dropped, each space a hyphen. */
export function slugOf(heading: string): string {
  const plain = heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*]/g, "")
    .replace(/\s+#+\s*$/, "");
  return plain
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

export function anchorsOf(text: string): ReadonlySet<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of proseLines(text, false)) {
    for (const m of line.matchAll(/\b(?:id|name)="([^"]+)"/g)) out.add(m[1] ?? "");
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const slug = slugOf(heading);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    out.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return out;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function checkLinks(root: string): ReadonlyArray<LinkProblem> {
  const problems: LinkProblem[] = [];
  const anchors = new Map<string, ReadonlySet<string>>();
  const anchorsIn = (file: string): ReadonlySet<string> => {
    let found = anchors.get(file);
    if (found === undefined) {
      found = anchorsOf(readFileSync(file, "utf8"));
      anchors.set(file, found);
    }
    return found;
  };

  for (const file of markdownFiles(root)) {
    const name = relative(root, file).split(sep).join("/");
    const fail = (line: number, link: string, reason: string): void =>
      void problems.push({ file: name, line, link, reason });
    proseLines(readFileSync(file, "utf8"), true).forEach((text, index) => {
      for (const m of text.matchAll(LINK)) {
        const link = (m[1] ?? "").replace(/^<|>$/g, "");
        if (link === "" || EXTERNAL.test(link)) continue;
        const [pathPart = "", anchor] = link.split("#", 2);
        const path = decode(pathPart.split("?")[0] ?? "");
        const target =
          path === "" ? file : path.startsWith("/") ? resolve(root, `.${path}`) : resolve(dirname(file), path);
        if (relative(root, target).startsWith("..")) fail(index + 1, link, "points outside the repository");
        else if (!existsSync(target)) fail(index + 1, link, "no such file");
        else if (
          anchor !== undefined &&
          anchor !== "" &&
          target.endsWith(".md") &&
          !anchorsIn(target).has(decode(anchor))
        ) {
          fail(index + 1, link, `no heading with the anchor #${anchor}`);
        }
      }
    });
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkLinks(join(import.meta.dirname, "..", ".."));
  for (const p of problems) process.stderr.write(`${p.file}:${p.line}: ${p.link}: ${p.reason}\n`);
  process.stdout.write(problems.length === 0 ? "links ok\n" : `${problems.length} broken link(s)\n`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
