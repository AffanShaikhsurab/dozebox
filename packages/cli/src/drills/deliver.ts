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
import { aws, arr, obj, shell, str, waitUntil } from "./box.ts";
import { POLL_MS } from "./tick.ts";
import type { DrillContext } from "./types.ts";

/**
 * Base64 characters per Run Command call. SSM allows about 64 KB of command text; the printf wrapper adds under 100
 * bytes, so a command stays below 58,100 bytes (a multiple of 4, so the parts concatenate to valid base64).
 */
export const CHUNK_CHARS = 58_000;
/** Chunks in flight at once, each into its own part file. */
export const IN_FLIGHT = 4;

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
    "set -eu", // AWS-RunShellScript runs the script with sh (dash): no pipefail
    `d=/var/tmp/dzd; v='${version}'; f="$d/dozebox-agent-$v-linux-$(uname -m).tar.gz"`,
    'cat "$d"/p[0-9]* | base64 -d > "$f" && rm -f "$d"/p[0-9]*', // zero-padded part names sort in order
    `echo '${sha}  '"$f" | sha256sum --check --status`,
    'rel="/opt/dozebox/releases/$v"; rm -rf "$rel.new"; mkdir -p "$rel.new"; tar -xzf "$f" -C "$rel.new"',
    'if [ ! -x "$rel.new/node/bin/node" ]; then',
    '  read -r nv nsha < "$rel.new/NODE"; na=x64; [ "$(uname -m)" = aarch64 ] && na=arm64',
    // A release already installed with this exact Node build (checked when it was installed) is copied, not fetched.
    '  have=""; for n in /opt/dozebox/releases/*/node/bin/node; do',
    '    if [ -x "$n" ] && [ "$("$n" --version 2>/dev/null)" = "$nv" ]; then have="$n"; break; fi',
    "  done",
    '  if [ -n "$have" ]; then',
    '    mkdir -p "$rel.new/node/bin"; cp -p "$have" "$rel.new/node/bin/node"; cp -p "$(dirname "$have")/../LICENSE" "$rel.new/node/" 2>/dev/null || true',
    "  else",
    '  curl -fsSL --retry 5 -o "$d/node.tar.xz" "https://nodejs.org/dist/$nv/node-$nv-linux-$na.tar.xz"',
    '  echo "$nsha  $d/node.tar.xz" | sha256sum --check --status',
    '  mkdir -p "$rel.new/node"',
    '  tar -xJf "$d/node.tar.xz" -C "$rel.new/node" --strip-components=1 "node-$nv-linux-$na/bin/node" "node-$nv-linux-$na/LICENSE"',
    "  fi",
    "fi",
    'rm -rf "$rel" && mv "$rel.new" "$rel"',
    // install-agent finds bin/dozeboxd in place, so it never downloads; it switches, installs units and starts.
    `/opt/dozebox/stage0/install-agent.sh "$v" https://release.invalid '${sha}'`,
    'rm -rf "$d"',
    // What the units did in their first seconds, for the report (a failed boot unit parks the box soon after).
    "sleep 15; systemctl is-active dozebox-boot dozeboxd || true",
    "journalctl -b -u dozebox-boot -u dozeboxd --no-pager -n 15 -o cat | cut -c1-200 || true",
    'echo "delivered $v"',
  ].join("\n");
}

/** The Run Command text of chunk `i`: its own numbered part file, so chunks may land in any order. */
export const chunkCommand = (i: number, part: string): string =>
  `printf %s '${part}' > /var/tmp/dzd/p${String(i).padStart(4, "0")}`;

/**
 * Waits until SSM lists the instance as Online (the earliest moment Run Command reaches it). An operator without
 * ssm:DescribeInstanceInformation falls back to probing with a no-op command.
 */
async function waitSsmOnline(ctx: DrillContext, instanceId: string, signal: AbortSignal): Promise<void> {
  await waitUntil(ctx, signal, POLL_MS, async () => {
    try {
      const out = await aws(
        ctx,
        ["ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${instanceId}`],
        signal,
      );
      return str(obj(arr(out["InstanceInformationList"])[0])["PingStatus"]) === "Online" ? true : null;
    } catch {
      if (signal.aborted) throw signal.reason;
      const r = await shell(ctx, instanceId, "true", signal, { check: false }).catch(() => null);
      return r?.status === "Success" ? true : null;
    }
  });
}

/** Runs `tasks` with at most `limit` in flight; the first failure stops the rest from starting and is thrown. */
async function pool(limit: number, tasks: ReadonlyArray<() => Promise<void>>): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const worker = async (): Promise<void> => {
    while (failed === null && next < tasks.length) {
      const task = tasks[next++];
      try {
        await task?.();
      } catch (e) {
        failed ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (failed !== null) throw failed;
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
  await waitSsmOnline(ctx, instanceId, signal);
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
  ctx.log(`deliver: ${version} to ${instanceId}, ${bytes.length} bytes in ${chunks} chunks (${IN_FLIGHT} at a time)`);
  await shell(ctx, instanceId, "rm -rf /var/tmp/dzd && mkdir -p /var/tmp/dzd", signal);
  await pool(
    IN_FLIGHT,
    Array.from({ length: chunks }, (_, i) => async () => {
      await shell(ctx, instanceId, chunkCommand(i, b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)), signal);
    }),
  );
  const out = await shell(ctx, instanceId, installScript(version, sha), signal, { timeoutSeconds: 600 });
  for (const line of out.stdout.trim().split("\n").slice(-18)) ctx.log(`deliver: ${line}`);
  ctx.facts.set("delivered", version);
}
