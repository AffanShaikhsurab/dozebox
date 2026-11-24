// Generate schema/v1/*.json and docs/reference/protocol-v1.md from the TypeBox schemas.
//   node scripts/gen-schema.ts                write the files
//   node scripts/gen-schema.ts --check        fail if any file differs (CI)
//   --out <dir> --docs <file>                 other locations (tests)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderDocs } from "./render-docs.ts";
import { SCHEMA_ID_BASE, SCHEMAS, schemaFileName } from "../src/registry.ts";

const pkg = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    out: { type: "string", default: join(pkg, "schema", "v1") },
    docs: { type: "string", default: join(pkg, "..", "..", "docs", "reference", "protocol-v1.md") },
  },
});

const wanted = new Map<string, string>();
for (const { title, schema } of SCHEMAS) {
  const file = schemaFileName(title);
  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SCHEMA_ID_BASE + file,
    title,
    ...JSON.parse(JSON.stringify(schema)),
  };
  wanted.set(join(values.out, file), JSON.stringify(doc, null, 2) + "\n");
}
wanted.set(values.docs, renderDocs(SCHEMAS));

const present = existsSync(values.out)
  ? readdirSync(values.out)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(values.out, f))
  : [];
const stale = present.filter((f) => !wanted.has(f));

if (values.check) {
  const drift: string[] = [];
  for (const [file, text] of wanted) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) drift.push(file);
  }
  drift.push(...stale);
  if (drift.length > 0) {
    for (const f of drift) console.error(`out of date: ${f}`);
    console.error("Run `pnpm --filter @dozebox/protocol gen:schema` and commit the result.");
    process.exit(1);
  }
  console.log(`gen-schema: ${wanted.size} files up to date`);
} else {
  for (const f of stale) rmSync(f);
  for (const [file, text] of wanted) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  console.log(`gen-schema: wrote ${wanted.size} files`);
}
