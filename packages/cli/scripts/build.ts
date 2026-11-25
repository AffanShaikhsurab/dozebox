// The CLI bundle: esbuild folds the workspace packages (core, client, protocol) and typebox into one file,
// dist/dozebox.mjs, so the published `dozebox` package has no workspace dependencies. The AWS SDK stays external
// and installs as ordinary runtime dependencies.
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export async function buildCli(outDir: string = join(ROOT, "dist")): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const pkg: { dependencies: Record<string, string> } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const outfile = join(outDir, "dozebox.mjs");
  await build({
    entryPoints: [join(ROOT, "src/bin.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    conditions: ["@dozebox/source"],
    external: Object.keys(pkg.dependencies),
    minify: false,
    legalComments: "none",
    logLevel: "warning",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  chmodSync(outfile, 0o755);
  return outfile;
}

if (import.meta.main) {
  process.stdout.write(`${await buildCli()}\n`);
}
