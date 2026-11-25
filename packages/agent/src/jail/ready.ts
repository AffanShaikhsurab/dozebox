// A8: the AppArmor profile bwrap needs on Ubuntu 24.04 (unprivileged user namespaces are restricted there) and the
// jail readiness fact `GET /v1/status` reports (`jail: { ready, egress, missing }`).
import type { Exec } from "../ports/exec.ts";
import type { Files } from "../ports/files.ts";
import { BWRAP } from "./bwrap.ts";
import { NFT_TABLE } from "./egress.ts";
import type { JailConfig } from "./types.ts";

export const APPARMOR_PROFILE = "/etc/apparmor.d/dozebox-bwrap";

/** Pure: grants `userns` to /usr/bin/bwrap only; everything else stays unconfined as before. */
export function renderAppArmorProfile(): string {
  return [
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    `profile dozebox-bwrap ${BWRAP} flags=(unconfined) {`,
    "  userns,",
    "  include if exists <local/dozebox-bwrap>",
    "}",
    "",
  ].join("\n");
}

export type JailReadiness = {
  readonly ready: boolean;
  readonly egress: "imds-only" | "allowlist" | "off";
  /** Parts not ready: `bwrap`, `apparmor`, `nftables`, `tripwire`. */
  readonly missing: ReadonlyArray<string>;
};

const runs = async (exec: Exec, argv: ReadonlyArray<string>, signal: AbortSignal): Promise<boolean> => {
  try {
    return (await exec.run(argv, { signal })).code === 0;
  } catch {
    return false;
  }
};

/** What is missing for the jail. With the jail off nothing is checked and it is not ready. */
export async function jailReadiness(
  deps: { readonly exec: Exec; readonly files: Files },
  cfg: JailConfig & { readonly tripwire: boolean },
  signal: AbortSignal,
): Promise<JailReadiness> {
  if (!cfg.enabled) return { ready: false, egress: "off", missing: ["jail"] };
  const missing: string[] = [];
  if (!(await runs(deps.exec, [BWRAP, "--version"], signal))) missing.push("bwrap");
  if ((await deps.files.readText(APPARMOR_PROFILE)) === null) missing.push("apparmor");
  if (!(await runs(deps.exec, ["nft", "list", "table", "inet", NFT_TABLE], signal))) missing.push("nftables");
  if (
    cfg.tripwire &&
    !(await runs(deps.exec, ["systemctl", "is-active", "--quiet", "dozebox-tripwire.socket"], signal))
  ) {
    missing.push("tripwire");
  }
  return { ready: missing.length === 0, egress: cfg.egress, missing };
}
