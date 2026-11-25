import type { Clock } from "@dozebox/core/time";
import type { PayloadDefinition } from "@dozebox/protocol/payload";
import type { Exec } from "../ports/exec.ts";
import type { HealthResult } from "../ports/payloads.ts";

export type HealthDeps = {
  readonly exec: Exec;
  readonly fetch: typeof fetch;
  readonly clock?: Pick<Clock, "timeout">;
};

const MAX_DETAIL = 200;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const unitName = (name: string): string => `dozebox-payload@${name}.service`;

/** One health check (http, command or systemd) as the definition describes it. */
export async function runHealthCheck(
  deps: HealthDeps,
  def: PayloadDefinition,
  signal: AbortSignal,
): Promise<HealthResult> {
  const ms = (def.health?.timeoutSeconds ?? 5) * 1000;
  const limited = AbortSignal.any([signal, deps.clock?.timeout(ms) ?? AbortSignal.timeout(ms)]);
  const done = (ok: boolean, detail: string): HealthResult => ({
    name: def.name,
    ok,
    detail: detail.slice(0, MAX_DETAIL),
  });
  try {
    const http = def.health?.http;
    if (http) {
      const res = await deps.fetch(http.url, { signal: limited });
      const ok =
        http.expectStatus === undefined ? res.status >= 200 && res.status < 400 : res.status === http.expectStatus;
      return done(ok, `HTTP ${res.status}`);
    }
    const command = def.health?.command;
    if (command) {
      const res = await deps.exec.run(["runuser", "-u", def.user, "--", ...command], { signal: limited });
      const stderr = res.stderr.slice(0, MAX_DETAIL);
      return done(res.code === 0, res.code === 0 ? "exit 0" : `exit ${res.code}${stderr ? `: ${stderr}` : ""}`);
    }
    const res = await deps.exec.run(["systemctl", "is-active", unitName(def.name)], { signal: limited });
    const state = res.stdout.trim();
    return done(state === "active", state || `exit ${res.code}`);
  } catch (e) {
    return done(false, message(e));
  }
}
