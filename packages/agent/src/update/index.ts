// A9: agent self-update: download the release, verify sha256, switch `/opt/dozebox/current`, restart, and roll back
// when the new agent misses `READY=1` within 120 s. Reports the outcome for `rec/release`. Runs outside dozeboxd
// (a transient unit), because restarting dozeboxd would end it.
import { createHash } from "node:crypto";
import type { Exec } from "../ports/exec.ts";
import type { Files } from "../ports/files.ts";

export const READY_DEADLINE_MS = 120_000;
export const RELEASES_DIR = "/opt/dozebox/releases";
export const CURRENT_LINK = "/opt/dozebox/current";
export const AGENT_UNIT = "dozeboxd.service";
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;

export type Release = { readonly version: string; readonly url: string; readonly sha256: string };

export type UpdateOutcome =
  | { readonly kind: "unchanged"; readonly version: string }
  | { readonly kind: "switched"; readonly from: string; readonly to: string }
  | { readonly kind: "refused"; readonly why: "checksum" | "download" }
  | { readonly kind: "rolled-back"; readonly from: string; readonly to: string; readonly why: string };

export type UpdateDeps = {
  readonly exec: Exec;
  readonly files: Files;
  readonly fetch: typeof fetch;
  readonly current: () => Promise<string>;
  /** Resolves true when the restarted agent sent READY=1 within `READY_DEADLINE_MS`. */
  readonly waitReady: (signal: AbortSignal) => Promise<boolean>;
  /** Binary write of the downloaded archive (Files only writes text). */
  readonly writeBytes: (path: string, data: Uint8Array) => Promise<void>;
  /** Called after a switch or a rollback, to write `rec/release`. A failure here does not undo the update. */
  readonly report?: (outcome: UpdateOutcome) => Promise<void>;
};

/** Pure: lower-case hex sha256 of `data`. */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const releaseDir = (version: string): string => `${RELEASES_DIR}/${version}`;

async function must(exec: Exec, argv: ReadonlyArray<string>, signal: AbortSignal): Promise<void> {
  const res = await exec.run(argv, { signal });
  if (res.code !== 0) throw new Error(`${argv.join(" ")} failed (${res.code}): ${res.stderr.slice(0, 300)}`);
}

/** Point CURRENT_LINK at `version` with one rename, so a crash leaves the old or the new link, never none. */
async function switchTo(exec: Exec, version: string, signal: AbortSignal): Promise<void> {
  await must(exec, ["ln", "-sfn", releaseDir(version), `${CURRENT_LINK}.next`], signal);
  await must(exec, ["mv", "-Tf", `${CURRENT_LINK}.next`, CURRENT_LINK], signal);
}

async function download(deps: UpdateDeps, target: Release, signal: AbortSignal): Promise<Uint8Array | null> {
  try {
    const res = await deps.fetch(target.url, { signal });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    if (signal.aborted) throw signal.reason;
    return null;
  }
}

export async function updateAgent(deps: UpdateDeps, target: Release, signal: AbortSignal): Promise<UpdateOutcome> {
  if (!VERSION.test(target.version)) throw new TypeError(`"${target.version}" is not a release version`);
  if (!target.url.startsWith("https://")) throw new TypeError("release urls must be https");
  const from = await deps.current();
  if (from === target.version) return { kind: "unchanged", version: from };

  const data = await download(deps, target, signal);
  if (data === null) return { kind: "refused", why: "download" };
  if (sha256Hex(data) !== target.sha256.toLowerCase()) return { kind: "refused", why: "checksum" };

  const dir = releaseDir(target.version);
  const archive = `${RELEASES_DIR}/${target.version}.tar.gz`;
  await must(deps.exec, ["mkdir", "-p", dir], signal);
  await deps.writeBytes(archive, data);
  await must(deps.exec, ["tar", "-xzf", archive, "-C", dir, "--no-same-owner"], signal);
  await must(deps.exec, ["rm", "-f", archive], signal);

  await switchTo(deps.exec, target.version, signal);
  await deps.exec.run(["systemctl", "restart", "--no-block", AGENT_UNIT], { signal });
  const outcome: UpdateOutcome = (await deps.waitReady(signal))
    ? { kind: "switched", from, to: target.version }
    : await rollBack(deps, from, target.version, signal);
  await deps.report?.(outcome).catch(() => {});
  return outcome;
}

async function rollBack(deps: UpdateDeps, back: string, failed: string, signal: AbortSignal): Promise<UpdateOutcome> {
  await switchTo(deps.exec, back, signal);
  await deps.exec.run(["systemctl", "restart", "--no-block", AGENT_UNIT], { signal });
  const ok = await deps.waitReady(signal);
  const why = `${failed} did not send READY=1 within ${READY_DEADLINE_MS / 1000} s${ok ? "" : `; ${back} did not either`}`;
  return { kind: "rolled-back", from: failed, to: back, why };
}
