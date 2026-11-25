// The agent release tarball: name, layout, modes, checksums, and that the bundles run with no node_modules.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildRelease, launcher, NATIVE_LIBS, parseArgs } from "../release/build-agent.ts";

const VERSION = "0.1.0-rc.1";
const name = `dozebox-agent-${VERSION}-linux-aarch64`;
let tmp = "";
let outDir = "";
let tarball = "";
let extracted = "";

const tar = (args: ReadonlyArray<string>): string => {
  const r = spawnSync("tar", args, { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "dz-release-"));
  const nodeDir = join(tmp, "fake-node");
  mkdirSync(join(nodeDir, "bin"), { recursive: true });
  writeFileSync(join(nodeDir, "bin", "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(nodeDir, "bin", "node"), 0o755);
  writeFileSync(join(nodeDir, "LICENSE"), "fake node license\n");
  mkdirSync(join(tmp, "so"));
  // Not a real library name: a fake libatomic.so.1 on the path would break the real node the launcher test runs.
  writeFileSync(join(tmp, "so", "libdztest.so.1"), "fake lib\n");
  outDir = join(tmp, "out");
  [tarball = ""] = await buildRelease({
    version: VERSION,
    arches: ["aarch64"],
    outDir,
    nodeDir,
    soDir: join(tmp, "so"),
  });
  extracted = join(tmp, "extracted");
  mkdirSync(extracted);
  tar(["-xzf", tarball, "-C", extracted]);
});

after(() => rmSync(tmp, { recursive: true, force: true }));

test("the tarball is named for the version and arch, with the release contents at its root", () => {
  assert.equal(tarball, join(outDir, `${name}.tar.gz`));
  const entries = tar(["-tzf", tarball]).split("\n").filter(Boolean);
  for (const want of [
    "bin/dozeboxd",
    "bin/dozebox",
    "bin/dozebox-boot",
    "bin/dozebox-shim",
    "bin/dozebox-jail-exec",
    "bin/dozebox-tripwire",
    "lib/dozeboxd.mjs",
    "lib/dozebox-boot.mjs",
    "lib/dozebox-shim.mjs",
    "lib/dozebox-jail-exec.mjs",
    "lib/dozebox-tripwire.mjs",
    "node/bin/node",
    "node/LICENSE",
    "lib/so/libdztest.so.1",
    "examples/marker/server.mjs",
    "VERSION",
  ]) {
    assert.ok(entries.includes(want), `${want} is in the tarball`);
  }
  assert.deepEqual(
    entries.filter((e) => e.startsWith("systemd/") && !e.endsWith("/")),
    [
      "systemd/dozebox-boot.service",
      "systemd/dozebox-payload@.service",
      "systemd/dozebox-payloads.slice",
      "systemd/dozeboxd.service",
    ],
  );
  assert.equal(readFileSync(join(extracted, "VERSION"), "utf8").trim(), VERSION);
});

test("the launchers are executable and the same tarball is built twice", async () => {
  for (const bin of ["dozeboxd", "dozebox", "dozebox-boot", "dozebox-shim", "dozebox-jail-exec", "dozebox-tripwire"]) {
    assert.equal(statSync(join(extracted, "bin", bin)).mode & 0o777, 0o755, bin);
  }
  assert.equal(readFileSync(join(extracted, "bin", "dozebox"), "utf8"), launcher("dozebox-shim"));
  const again = join(tmp, "again");
  const [second] = await buildRelease({
    version: VERSION,
    arches: ["aarch64"],
    outDir: again,
    nodeDir: join(tmp, "fake-node"),
    soDir: join(tmp, "so"),
  });
  assert.deepEqual(readFileSync(second ?? ""), readFileSync(tarball));
});

test("SHA256SUMS lists every tarball in sha256sum format", () => {
  const sums = readFileSync(join(outDir, "SHA256SUMS"), "utf8");
  const hex = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  assert.equal(sums, `${hex}  ${name}.tar.gz\n`);
});

test("the bundles are self-contained: the launcher runs with no node_modules", () => {
  const r = spawnSync(join(extracted, "bin", "dozebox"), ["--help"], { encoding: "utf8", cwd: extracted });
  assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
  assert.notEqual(r.status, null);
  assert.match(r.stderr, /dozebox|needs an id|unexpected/i);
});

test("the slim tarball has no node/ and names the Node build in NODE", () => {
  const slim = join(outDir, "slim", `${name}.tar.gz`);
  const entries = tar(["-tzf", slim]).split("\n").filter(Boolean);
  for (const want of ["NODE", "bin/dozeboxd", "lib/so/libdztest.so.1"]) assert.ok(entries.includes(want), want);
  assert.ok(!entries.some((e) => e.startsWith("node/")));
  assert.match(tar(["-xzOf", slim, "NODE"]), /^v\d+\.\d+\.\d+ [0-9a-f]{64}\n$/);
  assert.match(readFileSync(join(outDir, "slim", "SHA256SUMS"), "utf8"), new RegExp(`  ${name}\\.tar\\.gz\\n$`));
});

test("the launchers put the bundled shared libraries first on the library path", () => {
  // Ubuntu 24.04 has no libatomic1, which the arm64 node links: without lib/so first, node does not start.
  const dir = join(tmp, "ld");
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "node", "bin"), { recursive: true });
  writeFileSync(join(dir, "VERSION"), `${VERSION}\n`);
  writeFileSync(join(dir, "bin", "dozeboxd"), launcher("dozeboxd"), { mode: 0o755 });
  writeFileSync(join(dir, "node", "bin", "node"), '#!/bin/sh\necho "$LD_LIBRARY_PATH"\n', { mode: 0o755 });
  const run = (ld: string | undefined): string => {
    const env = { ...process.env };
    if (ld === undefined) delete env["LD_LIBRARY_PATH"];
    else env["LD_LIBRARY_PATH"] = ld;
    return spawnSync(join(dir, "bin", "dozeboxd"), [], { encoding: "utf8", env }).stdout.trim();
  };
  assert.equal(run(undefined), `${join(dir, "bin")}/../lib/so`);
  assert.equal(run("/elsewhere"), `${join(dir, "bin")}/../lib/so:/elsewhere`);
  assert.ok(NATIVE_LIBS.aarch64.some((l) => l.name === "libatomic.so.1"));
});

test("arguments: version is required and checked, arch is checked", () => {
  assert.throws(() => parseArgs([]), /--version is required/);
  assert.throws(() => parseArgs(["--version", "1.0.0", "--arch", "arm"]), /--arch/);
  assert.deepEqual(parseArgs(["--version", "1.0.0", "--arch", "x86_64"]).arches, ["x86_64"]);
  assert.deepEqual(parseArgs(["--version", "1.0.0"]).arches, ["aarch64", "x86_64"]);
});
