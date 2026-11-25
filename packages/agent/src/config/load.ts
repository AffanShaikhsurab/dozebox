// Read the box config and payload definitions from SSM, check them, and keep the last good copy (part 5 §5.4): an
// invalid config keeps the last good one and raises `rec/last-error` source `config`. Read at boot and every 5
// minutes (loops.ts). The last good copy is kept in memory and on disk, so a restart with a broken parameter still
// starts with the config the box ran last.
//
// Outcomes:
// - SSM copy valid: it becomes current and is saved to disk when it changed.
// - SSM copy invalid: `rec/last-error` (once per distinct problem), then the current or the saved copy.
// - SSM unreadable (throttled, network): the current or the saved copy, logged only, since a later read may work.
// - Either, with no copy to fall back to: `rec/last-error`, then RunnerError `invalid_input` (the agent exits and
//   systemd restarts it; its start limit leads to the park-now unit).
import { join } from "node:path";
import { RunnerError } from "@dozebox/core/errors";
import { messageOf } from "../errors.ts";
import type { Files } from "../ports/files.ts";
import type { Logger } from "../ports/log.ts";
import type { ParameterReader } from "../ports/params.ts";
import type { RecordPublisher } from "../records/publish.ts";
import { parseBoxConfig, parseLastGood, parsePayload, type AgentConfig, type Parsed } from "./parse.ts";

type LoadedConfig = AgentConfig & {
  /** "ssm": the copy just read; "last-good": the SSM copy was invalid or unreadable. */
  readonly from: "ssm" | "last-good";
  /** Why the SSM copy was not used, when `from` is "last-good". */
  readonly problem: string | null;
};

export type ConfigLoaderDeps = {
  readonly params: ParameterReader;
  readonly files: Files;
  readonly records: Pick<RecordPublisher, "lastError">;
  readonly log: Logger;
  readonly identity: { readonly boxId: string; readonly prefix: string };
  readonly stateDir: string;
};

export interface ConfigLoader {
  /** Read, check and fall back as above. Resolves with the config to run, or rejects when there is none. */
  readonly load: () => Promise<LoadedConfig>;
  /** The config from the last successful load. Throws before the first one. */
  readonly current: () => LoadedConfig;
}

export const lastGoodPath = (stateDir: string): string => join(stateDir, "config", "last-good.json");

type Read =
  | { readonly kind: "read"; readonly parsed: Parsed<AgentConfig> }
  | { readonly kind: "unreadable"; readonly problem: string };

async function readSsm(params: ParameterReader, expect: ConfigLoaderDeps["identity"]): Promise<Read> {
  try {
    const box = parseBoxConfig(await params.get("config"), expect);
    if (!box.ok) return { kind: "read", parsed: box };
    const payloads = [];
    for (const name of box.value.payloads) {
      const def = parsePayload(name, await params.get(`payloads/${name}`));
      if (!def.ok) return { kind: "read", parsed: def };
      payloads.push(def.value);
    }
    return { kind: "read", parsed: { ok: true, value: { box: box.value, payloads } } };
  } catch (e) {
    return { kind: "unreadable", problem: `config: SSM read failed: ${messageOf(e)}` };
  }
}

const same = (a: AgentConfig, b: AgentConfig): boolean =>
  JSON.stringify({ box: a.box, payloads: a.payloads }) === JSON.stringify({ box: b.box, payloads: b.payloads });

export function makeConfigLoader(deps: ConfigLoaderDeps): ConfigLoader {
  const log = deps.log.child({ component: "config" });
  const path = lastGoodPath(deps.stateDir);
  let current: LoadedConfig | null = null;
  let saved: AgentConfig | null = null;
  let reported: string | null = null;

  const report = async (problem: string): Promise<void> => {
    if (problem === reported) return;
    try {
      await deps.records.lastError("config", problem);
      reported = problem;
    } catch (e) {
      log.log("error", "could not write rec/last-error", { problem, error: e });
    }
  };

  const fallback = async (): Promise<AgentConfig | null> => {
    if (current) return current;
    try {
      const text = await deps.files.readText(path);
      if (text === null) return null;
      const disk = parseLastGood(text, deps.identity);
      if (disk.ok) return (saved = disk.value);
      log.log("warn", "the saved config is unusable", { problem: disk.problem });
    } catch (e) {
      log.log("warn", "could not read the saved config", { error: e });
    }
    return null;
  };

  const save = async (cfg: AgentConfig): Promise<void> => {
    if (saved && same(saved, cfg)) return;
    try {
      await deps.files.writeAtomic(path, `${JSON.stringify({ box: cfg.box, payloads: cfg.payloads })}\n`);
      saved = cfg;
    } catch (e) {
      log.log("error", "could not save the last good config", { error: e });
    }
  };

  const load = async (): Promise<LoadedConfig> => {
    const read = await readSsm(deps.params, deps.identity);
    if (read.kind === "read" && read.parsed.ok) {
      const cfg = read.parsed.value;
      if (current?.from === "last-good" || (current && !same(current, cfg))) log.log("info", "config changed");
      reported = null;
      await save(cfg);
      current = { ...cfg, from: "ssm", problem: null };
      return current;
    }
    const problem = read.kind === "read" ? (read.parsed.ok ? "" : read.parsed.problem) : read.problem;
    const keep = await fallback();
    if (read.kind === "read") await report(problem);
    if (!keep) {
      if (read.kind === "unreadable") await report(problem);
      throw new RunnerError("invalid_input", false, `${problem}; no last good config to fall back to`);
    }
    log.log("warn", "keeping the last good config", { problem });
    current = { box: keep.box, payloads: keep.payloads, from: "last-good", problem };
    return current;
  };

  return {
    load,
    current: () => {
      if (!current) throw new Error("config read before the first load");
      return current;
    },
  };
}
