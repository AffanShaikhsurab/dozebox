// A3: install hooks with a content-hash marker (`on-change` runs once per hash), secrets as LoadCredential files,
// health checks for health-only payloads, and the supervisor that implements the PayloadSupervisor port.
import type { PayloadDefinition } from "@dozebox/protocol/payload";
import type { Exec } from "../ports/exec.ts";
import type { Files } from "../ports/files.ts";
import type { Logger } from "../ports/log.ts";
import type { HealthResult, PayloadSupervisor } from "../ports/payloads.ts";

export type InstallOutcome = { readonly ran: boolean; readonly hash: string; readonly code: number | null };

/** Run `def.install` when its hash differs from the marker under `stateDir`; write the marker on success only. */
export function runInstallHook(
  _deps: { readonly exec: Exec; readonly files: Files; readonly stateDir: string },
  _def: PayloadDefinition,
  _signal: AbortSignal,
): Promise<InstallOutcome> {
  throw new Error("not implemented: A3 runInstallHook");
}

/** Fetch the definition's SecureStrings into `/run/dozebox/credentials/<payload>/<name>` (0600, root). */
export function writeCredentials(
  _deps: { readonly files: Files; readonly secret: (name: string) => Promise<string | null> },
  _def: PayloadDefinition,
): Promise<ReadonlyArray<string>> {
  throw new Error("not implemented: A3 writeCredentials");
}

/** One health check (http, command or systemd) as the definition describes it. */
export function runHealthCheck(
  _deps: { readonly exec: Exec; readonly fetch: typeof fetch },
  _def: PayloadDefinition,
  _signal: AbortSignal,
): Promise<HealthResult> {
  throw new Error("not implemented: A3 runHealthCheck");
}

export type SupervisorDeps = {
  readonly exec: Exec;
  readonly files: Files;
  readonly log: Logger;
  readonly fetch: typeof fetch;
  readonly stateDir: string;
  readonly payloads: () => ReadonlyArray<PayloadDefinition>;
  readonly secret: (name: string) => Promise<string | null>;
  /** The jail wrapper argv prefix (A8), empty when the jail is off. */
  readonly execPrefix: ReadonlyArray<string>;
};

export function makeSupervisor(_deps: SupervisorDeps): PayloadSupervisor {
  throw new Error("not implemented: A3 makeSupervisor");
}
