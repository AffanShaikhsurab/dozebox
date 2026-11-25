// License allowlist for production dependencies (WP-Z2).
// Usage: pnpm -r licenses list --prod --json | node scripts/check-licenses.ts --allow MIT,ISC,BSD-2-Clause
// Reads pnpm's JSON (license -> packages) on stdin, or from a file given with --input.
import { readFileSync } from "node:fs";

export const DEFAULT_ALLOW: ReadonlyArray<string> = [
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
];

export type LicenseProblem = { readonly name: string; readonly versions: string; readonly license: string };

type Entry = { readonly name: string; readonly versions: ReadonlyArray<string>; readonly license: string };

/** True when the SPDX expression is satisfied by the allowlist: OR needs one side, AND needs both. */
export function allowed(expression: string, allow: ReadonlySet<string>): boolean {
  const tokens = expression
    .replace(/[()]/g, (p) => ` ${p} `)
    .trim()
    .split(/\s+/);
  let i = 0;
  const atom = (): boolean => {
    const t = tokens[i++] ?? "";
    if (t === "(") {
      const v = or();
      i++;
      return v;
    }
    return allow.has(t.replace(/\+$/, ""));
  };
  const and = (): boolean => {
    let v = atom();
    while (tokens[i]?.toUpperCase() === "AND") {
      i++;
      v = atom() && v;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (tokens[i]?.toUpperCase() === "OR") {
      i++;
      v = and() || v;
    }
    return v;
  };
  const result = or();
  return i === tokens.length && result;
}

function entries(json: unknown): ReadonlyArray<Entry> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("expected pnpm licenses JSON");
  const out: Entry[] = [];
  for (const [license, list] of Object.entries(json)) {
    if (!Array.isArray(list)) throw new Error(`expected a list under ${license}`);
    for (const item of list as ReadonlyArray<Record<string, unknown>>) {
      const versions = Array.isArray(item["versions"]) ? item["versions"].map(String) : [];
      const own = typeof item["license"] === "string" ? item["license"] : license;
      out.push({ name: String(item["name"]), versions, license: own });
    }
  }
  return out;
}

export function checkLicenses(json: unknown, allow: ReadonlyArray<string>): ReadonlyArray<LicenseProblem> {
  const set = new Set(allow);
  return entries(json)
    .filter((e) => !allowed(e.license, set))
    .map((e) => ({ name: e.name, versions: e.versions.join(", "), license: e.license }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const allow =
    flag("--allow")
      ?.split(",")
      .map((s) => s.trim()) ?? DEFAULT_ALLOW;
  const raw = readFileSync(flag("--input") ?? 0, "utf8");
  const json: unknown = JSON.parse(raw);
  const count = entries(json).length;
  if (count === 0) {
    console.error("check-licenses: no packages in the input (run pnpm -r licenses list --prod --json)");
    process.exit(1);
  }
  const problems = checkLicenses(json, allow);
  for (const p of problems) console.error(`${p.name}@${p.versions}: ${p.license}`);
  if (problems.length > 0) process.exit(1);
  console.log(`check-licenses: ok, ${count} packages`);
}
