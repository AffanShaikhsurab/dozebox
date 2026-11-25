// A9: agent self-update: download the release, verify sha256, switch `/opt/dozebox/current`, restart, and roll back
// when the new agent misses `READY=1` within 120 s. Writes `rec/release`.
import type { Exec } from "../ports/exec.ts";
import type { Files } from "../ports/files.ts";

export const READY_DEADLINE_MS = 120_000;
export const RELEASES_DIR = "/opt/dozebox/releases";
export const CURRENT_LINK = "/opt/dozebox/current";

export type Release = { readonly version: string; readonly url: string; readonly sha256: string };

export type UpdateOutcome =
  | { readonly kind: "unchanged"; readonly version: string }
  | { readonly kind: "switched"; readonly from: string; readonly to: string }
  | { readonly kind: "refused"; readonly why: "checksum" | "download" }
  | { readonly kind: "rolled-back"; readonly from: string; readonly to: string; readonly why: string };

export function updateAgent(
  _deps: {
    readonly exec: Exec;
    readonly files: Files;
    readonly fetch: typeof fetch;
    readonly current: () => Promise<string>;
    /** Resolves true when the restarted agent sent READY=1 within `READY_DEADLINE_MS`. */
    readonly waitReady: (signal: AbortSignal) => Promise<boolean>;
  },
  _target: Release,
  _signal: AbortSignal,
): Promise<UpdateOutcome> {
  throw new Error("not implemented: A9 updateAgent");
}
