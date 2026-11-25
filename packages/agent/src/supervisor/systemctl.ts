import { RunnerError } from "@dozebox/core/errors";
import type { Exec } from "../ports/exec.ts";
import type { PayloadUnitState, UnitActiveState } from "../ports/payloads.ts";

const STATES: ReadonlyArray<UnitActiveState> = [
  "active",
  "activating",
  "deactivating",
  "inactive",
  "failed",
  "reloading",
];
const UNIT = /^dozebox-payload@(.+)\.service$/;

/** Run `systemctl <verb> <args>`; a non-zero exit is a retryable RunnerError. */
export async function systemctl(
  exec: Exec,
  verb: string,
  args: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<string> {
  const res = await exec.run(["systemctl", verb, ...args], signal ? { signal } : {});
  if (res.code !== 0) {
    throw new RunnerError(
      "internal",
      true,
      `systemctl ${verb} ${args.join(" ")}: exit ${res.code}: ${res.stderr.trim()}`,
    );
  }
  return res.stdout;
}

const toState = (v: string | undefined): UnitActiveState => STATES.find((s) => s === v) ?? "inactive";

/** Parse `systemctl show --timestamp=unix` output (blocks separated by blank lines) into unit states by name. */
export function parseStates(output: string): ReadonlyMap<string, PayloadUnitState> {
  const out = new Map<string, PayloadUnitState>();
  for (const block of output.split(/\r?\n\r?\n/)) {
    const props = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0) props.set(line.slice(0, i), line.slice(i + 1));
    }
    const name = UNIT.exec(props.get("Id") ?? "")?.[1];
    if (!name) continue;
    const since = /^@(\d+)$/.exec(props.get("ActiveEnterTimestamp") ?? "")?.[1];
    const restarts = Number.parseInt(props.get("NRestarts") ?? "", 10);
    out.set(name, {
      name,
      active: toState(props.get("ActiveState")),
      activeSince: since === undefined ? null : Number(since) * 1000,
      restarts: Number.isFinite(restarts) ? restarts : 0,
    });
  }
  return out;
}
