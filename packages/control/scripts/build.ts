// The control bundle (part 7 §7.2): esbuild bundles src/handler.ts with every dependency, the AWS SDK included, into
// dist/control.mjs, and zips it as dist/control.zip for the module's `control_bundle_path` (handler
// `control.handler`). The zip is deterministic, so Terraform redeploys only when the code changes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { unzip, zip } from "./zip.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export async function buildBundle(outDir: string = join(ROOT, "dist")): Promise<{ readonly zipPath: string }> {
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, "control.mjs");
  await build({
    entryPoints: [join(ROOT, "src/handler.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node26",
    format: "esm",
    conditions: ["@dozebox/source"],
    minify: false,
    legalComments: "none",
    logLevel: "warning",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const code = readFileSync(outfile);
  const archive = zip([{ name: "control.mjs", data: code }]);
  if (!unzip(archive).get("control.mjs")?.equals(code)) throw new Error("control.zip does not read back");
  const zipPath = join(outDir, "control.zip");
  writeFileSync(zipPath, archive);
  return { zipPath };
}

if (import.meta.main) {
  const { zipPath } = await buildBundle();
  process.stdout.write(`${zipPath}\n`);
}
