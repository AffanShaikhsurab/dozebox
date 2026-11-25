import { createHash } from "node:crypto";
import type { Clock } from "@dozebox/core/time";
import type { PayloadDefinition } from "@dozebox/protocol/payload";
import type { Exec } from "../ports/exec.ts";
import type { Files } from "../ports/files.ts";

export type InstallOutcome = { readonly ran: boolean; readonly hash: string; readonly code: number | null };

export type InstallDeps = {
  readonly exec: Exec;
  readonly files: Files;
  readonly stateDir: string;
  readonly clock?: Pick<Clock, "now" | "timeout">;
};

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]),
    );
  }
  return v;
};

const markerHash = (raw: string | null): string | null => {
  if (raw === null) return null;
  try {
    const hash = (JSON.parse(raw) as { hash?: unknown } | null)?.hash;
    return typeof hash === "string" ? hash : null;
  } catch {
    return null;
  }
};

/** Run `def.install` when its hash differs from the marker under `stateDir`; write the marker on success only. */
export async function runInstallHook(
  deps: InstallDeps,
  def: PayloadDefinition,
  signal: AbortSignal,
): Promise<InstallOutcome> {
  const install = def.install;
  if (!install) return { ran: false, hash: "", code: null };
  const hash = createHash("sha256")
    .update(JSON.stringify(canonical(install)))
    .digest("hex");
  const markerPath = `${deps.stateDir}/payloads/${def.name}/install.json`;
  const marked = markerHash(await deps.files.readText(markerPath));
  const due = install.when === "every-boot" || marked === null || (install.when === "on-change" && marked !== hash);
  if (!due) return { ran: false, hash, code: null };

  const timeout =
    deps.clock?.timeout(install.timeoutSeconds * 1000) ?? AbortSignal.timeout(install.timeoutSeconds * 1000);
  const argv = install.asRoot ? install.command : ["runuser", "-u", def.user, "--", ...install.command];
  const result = await deps.exec.run(argv, {
    cwd: `/data/payloads/${def.name}`,
    signal: AbortSignal.any([signal, timeout]),
  });
  if (result.code !== 0) return { ran: true, hash, code: result.code };
  const at = new Date(deps.clock?.now() ?? Date.now()).toISOString();
  await deps.files.writeAtomic(markerPath, JSON.stringify({ hash, when: install.when, at }));
  return { ran: true, hash, code: 0 };
}
