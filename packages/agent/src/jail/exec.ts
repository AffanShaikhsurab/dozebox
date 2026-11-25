// A8: `dozebox jail exec --context <id> [--bind-rw <path>]... [--ro <path>]... -- <cmd>...`, run as root through one
// sudoers rule. The caller is untrusted: every argument is checked, each path must resolve (symlinks followed) under
// `/data/payloads/<payload>/`, and the command runs through `jailArgv` as the payload's agent user.
import { posix } from "node:path";
import { RunnerError } from "@dozebox/core/errors";
import { jailArgv, type JailRun } from "./bwrap.ts";
import type { JailConfig } from "./types.ts";

export const PAYLOAD_DATA_ROOT = "/data/payloads";
const CONTEXT = /^[A-Za-z0-9._:-]{1,64}$/;

export type JailExecArgs = {
  readonly context: string;
  readonly bindRw: ReadonlyArray<string>;
  readonly readOnly: ReadonlyArray<string>;
  readonly command: ReadonlyArray<string>;
};

const usage = (why: string): RunnerError =>
  new RunnerError("invalid_input", false, `jail exec: ${why} (usage: --context <id> [--bind-rw <path>]... -- <cmd>)`);

/** A path under the payload's data dir, normalised; `..`, relative paths and the dir itself are refused. */
export function payloadPath(path: string, payload: string): string {
  const root = `${PAYLOAD_DATA_ROOT}/${payload}/`;
  if (!path.startsWith("/") || path.includes("\0")) throw usage(`"${path}" is not an absolute path`);
  if (path.split("/").includes("..")) throw usage(`"${path}" contains ..`);
  const norm = posix.normalize(path).replace(/\/+$/, "");
  if (!norm.startsWith(root)) throw usage(`"${path}" is not under ${root}`);
  return norm;
}

/** Pure: parse and check the arguments. */
export function parseJailExecArgs(argv: ReadonlyArray<string>, payload: string): JailExecArgs {
  let context: string | null = null;
  const bindRw: string[] = [];
  const readOnly: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    const value = argv[i + 1];
    if (value === undefined) throw usage(`${a} needs a value`);
    if (a === "--context") {
      if (!CONTEXT.test(value)) throw usage("the context must match ^[A-Za-z0-9._:-]{1,64}$");
      context = value;
    } else if (a === "--bind-rw") bindRw.push(payloadPath(value, payload));
    else if (a === "--ro") readOnly.push(payloadPath(value, payload));
    else throw usage(`unknown option ${a}`);
    i++;
  }
  const command = argv.slice(i + 1);
  if (context === null) throw usage("--context is required");
  if (i >= argv.length || command.length === 0) throw usage("no command after --");
  return { context, bindRw, readOnly, command };
}

export type JailExecDeps = {
  /** fs.realpath: a symlink under the data dir must not lead out of it. */
  readonly realpath: (path: string) => Promise<string>;
  readonly config: JailConfig;
  readonly payload: string;
  /** The payload's agent user (`<payload>-agent`, uid >= 60000). */
  readonly agentUid: number;
  readonly decoy: boolean;
};

/**
 * Check, resolve symlinks, and return the full argv to run (jail prefix + command). The `dozebox-jail-exec` bin
 * spawns it with inherited stdio and exits with its code.
 */
export async function resolveJailExec(deps: JailExecDeps, argv: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
  if (!deps.config.enabled) throw new RunnerError("invalid_input", false, "jail exec: the jail is off on this box");
  const args = parseJailExecArgs(argv, deps.payload);
  const real = async (p: string): Promise<string> => payloadPath(await deps.realpath(p), deps.payload);
  const run: JailRun = {
    bindRw: await Promise.all(args.bindRw.map(real)),
    readOnly: await Promise.all(args.readOnly.map(real)),
    context: args.context,
    decoy: deps.decoy,
  };
  return [...jailArgv(deps.config, deps.payload, deps.agentUid, run), ...args.command];
}
