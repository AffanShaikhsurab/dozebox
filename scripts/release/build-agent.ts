// Builds the agent release tarballs that box/stage0/install-agent.sh downloads.
//   node scripts/release/build-agent.ts --version <semver> [--arch aarch64] [--arch x86_64] [--out dist/release]
//                                       [--node-dir <extracted node dir>]
// Each tarball holds the release dir's contents at its root: bin/ launchers, lib/ bundles and lib/so shared libraries,
// node/, systemd/, examples/.
// `slim/` gets the same tarballs without node/ (a NODE file names the Node build instead), small enough for
// `dozebox drill --deliver` to push through SSM Run Command.
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildAgent } from "../../packages/agent/scripts/build.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The Node shipped in every release (the version installed on the build box). */
export const NODE_VERSION = "26.12.1";

export type Arch = "aarch64" | "x86_64";
const NODE_ARCH: Readonly<Record<Arch, string>> = { aarch64: "arm64", x86_64: "x64" };

const LAUNCHERS: Readonly<Record<string, string>> = {
  dozeboxd: "dozeboxd",
  "dozebox-boot": "dozebox-boot",
  "dozebox-shim": "dozebox-shim",
  "dozebox-jail-exec": "dozebox-jail-exec",
  "dozebox-tripwire": "dozebox-tripwire",
  dozebox: "dozebox-shim",
};
const UNITS = ["dozebox-boot.service", "dozeboxd.service", "dozebox-payload@.service", "dozebox-payloads.slice"];
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export type ReleaseOptions = {
  readonly version: string;
  readonly arches: ReadonlyArray<Arch>;
  readonly outDir: string;
  /** An extracted Node dir (bin/node, LICENSE) used instead of downloading; for tests. */
  readonly nodeDir?: string;
  /** A dir of shared libraries used instead of NATIVE_LIBS; for tests. */
  readonly soDir?: string;
};

/**
 * Shared libraries the official Node build links that the module's default AMI (Ubuntu 24.04 server) lacks: node
 * needs libatomic.so.1 (both arches) and stock Ubuntu does not install libatomic1. Taken from Ubuntu noble's release
 * pocket (never removed from the pool), checked, shipped in lib/so (full and slim) and found via LD_LIBRARY_PATH.
 */
export const NATIVE_LIBS: Readonly<
  Record<
    Arch,
    ReadonlyArray<{ readonly url: string; readonly sha256: string; readonly path: string; readonly name: string }>
  >
> = {
  aarch64: [
    {
      url: "https://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-14/libatomic1_14-20240412-0ubuntu1_arm64.deb",
      sha256: "017fa4bd88e8ff1cbaf75a26765b8c1255a5cd91d6ce838273bcb64190f15e37",
      path: "usr/lib/aarch64-linux-gnu/libatomic.so.1.2.0",
      name: "libatomic.so.1",
    },
  ],
  x86_64: [
    {
      url: "https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-14/libatomic1_14-20240412-0ubuntu1_amd64.deb",
      sha256: "f496d80626e1512456273965d44f47b281edf53fa26d0d8bd0defc5be7e4601c",
      path: "usr/lib/x86_64-linux-gnu/libatomic.so.1.2.0",
      name: "libatomic.so.1",
    },
  ],
};

export const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

export const launcher = (lib: string): string =>
  `#!/bin/sh\nhere="$(dirname "$(readlink -f "$0")")"\nDOZEBOX_AGENT_VERSION="$(cat "$here/../VERSION")"\nexport DOZEBOX_AGENT_VERSION\nLD_LIBRARY_PATH="$here/../lib/so\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\nexport LD_LIBRARY_PATH\nexec "$here/../node/bin/node" "$here/../lib/${lib}.mjs" "$@"\n`;

function run(cmd: string, args: ReadonlyArray<string>): void {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
  renameSync(`${dest}.part`, dest);
}

/** Download (or reuse from the cache) the Node tarball for `arch`, verify it against SHASUMS256.txt, extract it. */
async function fetchNode(arch: Arch, cacheDir: string): Promise<{ readonly dir: string; readonly sha: string }> {
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const name = `node-v${NODE_VERSION}-linux-${NODE_ARCH[arch]}`;
  mkdirSync(cacheDir, { recursive: true });
  const sums = join(cacheDir, `SHASUMS256-v${NODE_VERSION}.txt`);
  if (!existsSync(sums)) await download(`${base}/SHASUMS256.txt`, sums);
  const archive = join(cacheDir, `${name}.tar.xz`);
  if (!existsSync(archive)) await download(`${base}/${name}.tar.xz`, archive);
  const line = readFileSync(sums, "utf8")
    .split("\n")
    .find((l) => l.endsWith(`  ${name}.tar.xz`));
  const want = line?.split(/\s+/)[0];
  if (!want) throw new Error(`${name}.tar.xz is not in SHASUMS256.txt`);
  if (sha256(readFileSync(archive)) !== want) {
    rmSync(archive);
    throw new Error(`${name}.tar.xz does not match SHASUMS256.txt; deleted it, run again`);
  }
  const dir = join(cacheDir, name);
  if (!existsSync(join(dir, "bin", "node"))) run("tar", ["-xJf", archive, "-C", cacheDir]);
  return { dir, sha: want };
}

/** Download (or reuse) the Ubuntu packages of NATIVE_LIBS[arch], check them, extract the libraries into one dir. */
async function fetchNativeLibs(arch: Arch, cacheDir: string): Promise<string> {
  const out = join(cacheDir, `so-${arch}`);
  mkdirSync(out, { recursive: true });
  for (const lib of NATIVE_LIBS[arch]) {
    if (existsSync(join(out, lib.name))) continue;
    const deb = join(cacheDir, lib.url.slice(lib.url.lastIndexOf("/") + 1));
    if (!existsSync(deb)) await download(lib.url, deb);
    if (sha256(readFileSync(deb)) !== lib.sha256) {
      rmSync(deb);
      throw new Error(`${lib.url} does not match its pinned SHA-256; deleted it`);
    }
    const x = join(cacheDir, `deb-${lib.name}`);
    rmSync(x, { recursive: true, force: true });
    run("dpkg-deb", ["-x", deb, x]);
    copyFileSync(join(x, lib.path), join(out, lib.name));
    rmSync(x, { recursive: true, force: true });
  }
  return out;
}

/** `node` null: a slim release, with NODE naming the Node build to fetch instead of node/. */
function assemble(
  stage: string,
  version: string,
  node: { readonly dir: string } | { readonly nodeLine: string },
  libDir: string,
  root: string,
  soDir: string,
): void {
  rmSync(stage, { recursive: true, force: true });
  for (const d of ["bin", "lib/so", "systemd", "examples/marker"]) mkdirSync(join(stage, d), { recursive: true });
  for (const so of readdirSync(soDir)) copyFileSync(join(soDir, so), join(stage, "lib", "so", so));
  for (const [bin, lib] of Object.entries(LAUNCHERS)) {
    writeFileSync(join(stage, "bin", bin), launcher(lib), { mode: 0o755 });
    chmodSync(join(stage, "bin", bin), 0o755);
  }
  for (const lib of new Set(Object.values(LAUNCHERS)))
    copyFileSync(join(libDir, `${lib}.mjs`), join(stage, "lib", `${lib}.mjs`));
  if ("dir" in node) {
    mkdirSync(join(stage, "node", "bin"), { recursive: true });
    copyFileSync(join(node.dir, "bin", "node"), join(stage, "node", "bin", "node"));
    chmodSync(join(stage, "node", "bin", "node"), 0o755);
    if (existsSync(join(node.dir, "LICENSE"))) copyFileSync(join(node.dir, "LICENSE"), join(stage, "node", "LICENSE"));
  } else writeFileSync(join(stage, "NODE"), `${node.nodeLine}\n`);
  for (const unit of UNITS) copyFileSync(join(root, "box", "systemd", unit), join(stage, "systemd", unit));
  copyFileSync(
    join(root, "examples", "payloads", "marker", "server.mjs"),
    join(stage, "examples", "marker", "server.mjs"),
  );
  writeFileSync(join(stage, "VERSION"), `${version}\n`);
}

function pack(stage: string, tarball: string): string {
  const entries = readdirSync(stage).toSorted();
  run("tar", [
    "--sort=name",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mtime=@0",
    "-I",
    "gzip -n",
    "-cf",
    tarball,
    "-C",
    stage,
    ...entries,
  ]);
  return tarball;
}

function writeSums(dir: string): void {
  const all = readdirSync(dir)
    .filter((f) => f.endsWith(".tar.gz"))
    .toSorted();
  writeFileSync(join(dir, "SHA256SUMS"), all.map((f) => `${sha256(readFileSync(join(dir, f)))}  ${f}\n`).join(""));
}

/** Builds one tarball per arch plus SHA256SUMS in `outDir`; returns the tarball paths. */
export async function buildRelease(opts: ReleaseOptions): Promise<ReadonlyArray<string>> {
  if (!SEMVER.test(opts.version)) throw new Error(`not a semver: ${opts.version}`);
  const outDir = resolve(opts.outDir);
  const work = join(outDir, ".work");
  mkdirSync(work, { recursive: true });
  const libDir = join(work, "lib");
  await buildAgent(libDir);
  const tarballs: string[] = [];
  const slimDir = join(outDir, "slim");
  mkdirSync(slimDir, { recursive: true });
  for (const arch of opts.arches) {
    const node = opts.nodeDir
      ? { dir: resolve(opts.nodeDir), sha: "0".repeat(64) }
      : await fetchNode(arch, join(outDir, ".cache"));
    const name = `dozebox-agent-${opts.version}-linux-${arch}`;
    const stage = join(work, name);
    const soDir = opts.soDir ? resolve(opts.soDir) : await fetchNativeLibs(arch, join(outDir, ".cache"));
    assemble(stage, opts.version, node, libDir, ROOT, soDir);
    tarballs.push(pack(stage, join(outDir, `${name}.tar.gz`)));
    assemble(stage, opts.version, { nodeLine: `v${NODE_VERSION} ${node.sha}` }, libDir, ROOT, soDir);
    pack(stage, join(slimDir, `${name}.tar.gz`));
  }
  writeSums(outDir);
  writeSums(slimDir);
  rmSync(work, { recursive: true, force: true });
  return tarballs;
}

export function parseArgs(argv: ReadonlyArray<string>): ReleaseOptions {
  const arches: Arch[] = [];
  let version = "";
  let outDir = "dist/release";
  let nodeDir: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--version") version = value;
    else if (flag === "--out") outDir = value;
    else if (flag === "--node-dir") nodeDir = value;
    else if (flag === "--arch") {
      if (value !== "aarch64" && value !== "x86_64") throw new Error(`--arch is aarch64 or x86_64, not ${value}`);
      arches.push(value);
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (!version) throw new Error("--version is required");
  return {
    version,
    arches: arches.length > 0 ? arches : ["aarch64", "x86_64"],
    outDir,
    ...(nodeDir ? { nodeDir } : {}),
  };
}

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    for (const tarball of await buildRelease(opts)) {
      const sum = sha256(readFileSync(tarball));
      process.stdout.write(`${tarball}\n  sha256 ${sum}\n`);
    }
  } catch (e) {
    process.stderr.write(`build-agent: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
