// The agent bundles: esbuild bundles each `bin` entry with every dependency, the AWS SDK included, into one
// self-contained ESM file under dist/, because the box has no node_modules. The release tarball ships these files.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Entry source (relative to the package) -> bundle name (no extension). One per `bin` of package.json. */
export const AGENT_ENTRIES: Readonly<Record<string, string>> = {
  "src/main.ts": "dozeboxd",
  "src/boot/main.ts": "dozebox-boot",
  "src/bin/dozebox.ts": "dozebox-shim",
  "src/bin/jail-exec.ts": "dozebox-jail-exec",
  "src/bin/tripwire.ts": "dozebox-tripwire",
};

export async function buildAgent(outDir: string = join(ROOT, "dist")): Promise<ReadonlyArray<string>> {
  mkdirSync(outDir, { recursive: true });
  const names = Object.values(AGENT_ENTRIES);
  await Promise.all(
    Object.entries(AGENT_ENTRIES).map(([entry, name]) =>
      build({
        entryPoints: [join(ROOT, entry)],
        outfile: join(outDir, `${name}.mjs`),
        bundle: true,
        platform: "node",
        target: "node26",
        format: "esm",
        conditions: ["@dozebox/source"],
        minify: false,
        legalComments: "none",
        logLevel: "warning",
        banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      }),
    ),
  );
  return names.map((name) => join(outDir, `${name}.mjs`));
}

if (import.meta.main) {
  for (const file of await buildAgent()) process.stdout.write(`${file}\n`);
}
