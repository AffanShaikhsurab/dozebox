// `--deliver <tarball>`: push an agent release to the box through SSM Run Command, for boxes that cannot download it
// (stage 0 fetches from the release URL, and a private repository's release assets need a token). The tarball goes
// over in base64 chunks, is checked against its SHA-256 on the box, unpacked into /opt/dozebox/releases/<v>, and
// stage 0's install-agent.sh then switches to it and starts the units exactly as after a download. A slim tarball
// (no node/) names its Node build in NODE ("v26.x.y <sha256 of the linux tar.xz>"); the box fetches that from
// nodejs.org and checks it.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { DozeboxCliError } from "../command.ts";
import { shell } from "./box.ts";
import type { DrillContext } from "./types.ts";

/** Base64 characters per Run Command call (SSM caps one command's parameters well above this). */
export const CHUNK_CHARS = 48_000;

const NAME = /^dozebox-agent-([0-9A-Za-z][0-9A-Za-z.+-]{0,39})-linux-(aarch64|x86_64)\.tar\.gz$/;

export function releaseOf(path: string): { readonly version: string; readonly arch: string } {
  const m = NAME.exec(basename(path));
  if (m === null)
    throw new DozeboxCliError("usage", `--deliver ${path} is not a dozebox-agent-<v>-linux-<arch>.tar.gz`);
  return { version: m[1] ?? "", arch: m[2] ?? "" };
}

/** The box-side install script (pure, tested). */
export function installScript(version: string, sha: string): string {
  return [
    "set -euo pipefail",
    `d=/var/tmp/dzd; v='${version}'; f="$d/dozebox-agent-$v-linux-$(uname -m).tar.gz"`,
    'base64 -d "$d/a.b64" > "$f" && rm -f "$d/a.b64"',
    `echo '${sha}  '"$f" | sha256sum --check --status`,
    'rel="/opt/dozebox/releases/$v"; rm -rf "$rel.new"; mkdir -p "$rel.new"; tar -xzf "$f" -C "$rel.new"',
    'if [ ! -x "$rel.new/node/bin/node" ]; then',
    '  read -r nv nsha < "$rel.new/NODE"; na=x64; [ "$(uname -m)" = aarch64 ] && na=arm64',
    '  curl -fsSL --retry 5 -o "$d/node.tar.xz" "https://nodejs.org/dist/$nv/node-$nv-linux-$na.tar.xz"',
    '  echo "$nsha  $d/node.tar.xz" | sha256sum --check --status',
    '  mkdir -p "$rel.new/node"',
    '  tar -xJf "$d/node.tar.xz" -C "$rel.new/node" --strip-components=1 "node-$nv-linux-$na/bin/node" "node-$nv-linux-$na/LICENSE"',
    "fi",
    'rm -rf "$rel" && mv "$rel.new" "$rel"',
    // install-agent finds bin/dozeboxd in place, so it never downloads; it switches, installs units and starts.
    `/opt/dozebox/stage0/install-agent.sh "$v" https://release.invalid '${sha}'`,
    'rm -rf "$d"',
    'echo "delivered $v"',
  ].join("\n");
}

/** Pushes `ctx.options.deliver` to the instance unless it already runs that version. */
export async function deliverAgent(
  ctx: DrillContext,
  instanceId: string,
  signal: AbortSignal,
  read: (path: string) => Promise<Uint8Array> = readFile,
): Promise<void> {
  const path = ctx.options.deliver;
  if (path === null) return;
  const { version, arch } = releaseOf(path);
  const seen = await shell(ctx, instanceId, "cat /opt/dozebox/current/VERSION 2>/dev/null || true; uname -m", signal);
  const [current = "", boxArch = ""] = seen.stdout.trim().split("\n");
  if (boxArch.trim() !== "" && boxArch.trim() !== arch) {
    throw new DozeboxCliError("usage", `--deliver is ${arch}; ${instanceId} is ${boxArch.trim()}`);
  }
  if (current.trim() === version) {
    ctx.log(`deliver: ${instanceId} already runs ${version}`);
    return;
  }
  const bytes = await read(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const b64 = Buffer.from(bytes).toString("base64");
  const chunks = Math.ceil(b64.length / CHUNK_CHARS);
  ctx.log(`deliver: ${version} to ${instanceId}, ${bytes.length} bytes in ${chunks} chunks`);
  await shell(ctx, instanceId, "rm -rf /var/tmp/dzd && mkdir -p /var/tmp/dzd", signal);
  for (let i = 0; i < chunks; i++) {
    const part = b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
    await shell(ctx, instanceId, `printf %s '${part}' >> /var/tmp/dzd/a.b64`, signal);
  }
  const out = await shell(ctx, instanceId, installScript(version, sha), signal, { timeoutSeconds: 600 });
  ctx.log(`deliver: ${out.stdout.trim().split("\n").at(-1) ?? ""}`);
  ctx.facts.set("delivered", version);
}
