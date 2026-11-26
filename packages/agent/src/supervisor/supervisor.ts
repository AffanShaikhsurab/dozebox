// A3: the supervisor that implements the PayloadSupervisor port over systemd. The install hook, credentials and
// health checks live in their own files and are re-exported from `index.ts`.
import { RunnerError } from "@dozebox/core/errors";
import type { Clock } from "@dozebox/core/time";
import type { PayloadDefinition } from "@dozebox/protocol/payload";
import type { Exec } from "../ports/exec.ts";
import type { Files } from "../ports/files.ts";
import type { Logger } from "../ports/log.ts";
import type { PayloadSupervisor } from "../ports/payloads.ts";
import { runHealthCheck, unitName } from "./health.ts";
import { runInstallHook } from "./install.ts";
import { writeCredentials } from "./secrets.ts";
import { verifyJailSudo } from "./sudo.ts";
import { parseStates, systemctl } from "./systemctl.ts";
import { renderUnit } from "./units.ts";
import { ensureUser } from "./users.ts";
import { socketPath } from "../protocol/server.ts";

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
  /** Exported to payloads as DOZEBOX_BOX_ID. */
  readonly boxId: string;
  readonly clock?: Pick<Clock, "now" | "timeout">;
  /** Test seam; defaults to `renderUnit`. */
  readonly render?: typeof renderUnit;
};

export function makeSupervisor(deps: SupervisorDeps): PayloadSupervisor {
  const render = deps.render ?? renderUnit;
  const log = deps.log.child({ component: "supervisor" });
  // Payloads whose drop-in this process rendered; one that leaves the config is stopped, its file stays.
  const rendered = new Set<string>();

  /** Prepare one payload up to its drop-in; true when the drop-in file changed. */
  const prepare = async (def: PayloadDefinition, signal: AbortSignal): Promise<boolean> => {
    await ensureUser(deps.exec, def.user, signal);
    const dir = `/data/payloads/${def.name}`;
    const mk = await deps.exec.run(["install", "-d", "-o", def.user, "-g", def.user, "-m", "0750", dir], { signal });
    if (mk.code !== 0)
      throw new RunnerError("internal", false, `install -d ${dir}: exit ${mk.code}: ${mk.stderr.trim()}`);
    const credentials = await writeCredentials(deps, def);
    const options = {
      socketPath: socketPath(def.name),
      credentials,
      execPrefix: deps.execPrefix,
      boxId: deps.boxId,
    };
    const unit = render(def, options);
    rendered.add(def.name);
    if ((await deps.files.readText(unit.path)) === unit.text) return false;
    await deps.files.writeAtomic(unit.path, unit.text);
    return true;
  };

  const startAll = async (signal: AbortSignal): Promise<void> => {
    const defs = deps.payloads();
    const current = new Set(defs.map((d) => d.name));
    const dropped = [...rendered].filter((n) => !current.has(n));
    for (const name of dropped) {
      log.log("warn", "payload left the config; stopping it and keeping its drop-in", { payload: name });
      await systemctl(deps.exec, "stop", [unitName(name)], signal);
      rendered.delete(name);
    }

    const changed = new Set<string>();
    for (const def of defs) if (await prepare(def, signal)) changed.add(def.name);
    if (changed.size > 0) await systemctl(deps.exec, "daemon-reload", [], signal);

    for (const def of defs) {
      if (def.start.noNewPrivileges === false) {
        const verdict = await verifyJailSudo(deps.exec, def.user, signal);
        if (!verdict.ok) {
          throw new RunnerError(
            "invalid_input",
            false,
            `payload ${def.name}: refusing to start: ${verdict.detail}; run it as a dedicated user whose only sudo right is the jail-exec rule`,
          );
        }
      }
      const unit = unitName(def.name);
      const install = await runInstallHook(deps, def, signal);
      if (install.ran && install.code !== 0) {
        throw new RunnerError("internal", false, `payload ${def.name}: install hook exited ${install.code}`);
      }
      const active =
        changed.has(def.name) && (await deps.exec.run(["systemctl", "is-active", unit], { signal })).code === 0;
      await systemctl(deps.exec, active ? "restart" : "start", [unit], signal);
      log.log("info", active ? "payload restarted" : "payload started", { payload: def.name });
    }
  };

  const stopAll = async (signal: AbortSignal): Promise<void> => {
    const units = [...new Set([...deps.payloads().map((d) => d.name), ...rendered])].map(unitName);
    if (units.length === 0) return;
    try {
      await systemctl(deps.exec, "stop", units, signal);
    } catch (e) {
      if (!signal.aborted) throw e;
      log.log("warn", "stop did not finish in time; killing payloads", { units });
      await systemctl(deps.exec, "kill", ["--signal=SIGKILL", ...units]);
    }
  };

  const states = async () => {
    const defs = deps.payloads();
    if (defs.length === 0) return [];
    const out = await systemctl(deps.exec, "show", [
      "--timestamp=unix",
      "--property=Id,ActiveState,ActiveEnterTimestamp,NRestarts",
      ...defs.map((d) => unitName(d.name)),
    ]);
    const parsed = parseStates(out);
    return defs.map(
      (d) => parsed.get(d.name) ?? { name: d.name, active: "inactive" as const, activeSince: null, restarts: 0 },
    );
  };

  return {
    startAll,
    stopAll,
    restart: async (name, signal) => {
      await systemctl(deps.exec, "restart", [unitName(name)], signal);
    },
    states,
    checkHealth: (signal) => Promise.all(deps.payloads().map((d) => runHealthCheck(deps, d, signal))),
  };
}
