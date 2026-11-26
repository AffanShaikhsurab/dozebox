// A8: `dozebox jail exec --context <id> [--bind-rw <path>]... [--ro <path>]... [--env-file <path>] [--chdir <path>]
// -- <cmd>...`, run as root through one sudoers rule. The caller is untrusted: every argument is checked, each path
// must resolve (symlinks followed) under `/data/payloads/<payload>/`, and the command runs through `jailArgv` as the
// payload's agent user.
import { posix } from "node:path";
import { RunnerError } from "@dozebox/core/errors";
import { ENV_ARGS_FD, jailArgv, type JailRun } from "./bwrap.ts";
import type { JailConfig } from "./types.ts";

export const PAYLOAD_DATA_ROOT = "/data/payloads";
const CONTEXT = /^[A-Za-z0-9._:-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names the jail owns: PATH decides what the agent runs, DOZEBOX_CONTEXT attributes a tripwire hit. */
const ENV_REFUSED = new Set(["PATH", "DOZEBOX_CONTEXT"]);
export const ENV_FILE_MAX_BYTES = 1024 * 1024;
export const ENV_FILE_MAX_RECORDS = 512;

export type JailExecArgs = {
  readonly context: string;
  readonly bindRw: ReadonlyArray<string>;
  readonly readOnly: ReadonlyArray<string>;
  /** `--env-file`: root reads it, then deletes it; its pairs reach bwrap on a fd, never on argv. */
  readonly envFile: string | null;
  /** `--chdir`: where the command starts; must be inside a bind. Defaults to the first read-write bind. */
  readonly chdir: string | null;
  readonly command: ReadonlyArray<string>;
};

const usage = (why: string): RunnerError =>
  new RunnerError(
    "invalid_input",
    false,
    `jail exec: ${why} (usage: --context <id> [--bind-rw <path>]... [--ro <path>]... [--env-file <path>] [--chdir <path>] -- <cmd>)`,
  );

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
  let envFile: string | null = null;
  let chdir: string | null = null;
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
    else if (a === "--env-file") envFile = payloadPath(value, payload);
    else if (a === "--chdir") chdir = payloadPath(value, payload);
    else throw usage(`unknown option ${a}`);
    i++;
  }
  const command = argv.slice(i + 1);
  if (context === null) throw usage("--context is required");
  if (i >= argv.length || command.length === 0) throw usage("no command after --");
  return { context, bindRw, readOnly, envFile, chdir, command };
}

export type JailEnvEntry = readonly [name: string, value: string];

/**
 * Parse the `--env-file` content: `NAME=value` records separated by NUL bytes, so a value may hold newlines. One
 * trailing NUL is allowed. Errors name the record's position, never its value, because the value may be a secret.
 */
export function parseEnvFile(bytes: Uint8Array): ReadonlyArray<JailEnvEntry> {
  if (bytes.length > ENV_FILE_MAX_BYTES) throw usage(`the env file is over ${ENV_FILE_MAX_BYTES} bytes`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw usage("the env file is not UTF-8");
  }
  if (text === "") return [];
  const records = text.split("\0");
  if (records.at(-1) === "") records.pop();
  if (records.length > ENV_FILE_MAX_RECORDS) throw usage(`the env file has more than ${ENV_FILE_MAX_RECORDS} records`);
  return records.map((record, i) => {
    const eq = record.indexOf("=");
    if (eq < 1) throw usage(`env record ${i + 1} is not NAME=value`);
    const name = record.slice(0, eq);
    if (!ENV_NAME.test(name)) throw usage(`env record ${i + 1} has a bad name`);
    if (ENV_REFUSED.has(name)) throw usage(`the env file may not set ${name}`);
    return [name, record.slice(eq + 1)] as const;
  });
}

/** The bwrap `--args` stream: one `--setenv NAME value` triple per record, NUL-separated. */
export function envArgsContent(entries: ReadonlyArray<JailEnvEntry>): string {
  if (entries.length === 0) return "";
  return `${entries.flatMap(([name, value]) => ["--setenv", name, value]).join("\0")}\0`;
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

export type JailExecPlan = {
  /** The jail prefix and the command: what the bin execs. */
  readonly argv: ReadonlyArray<string>;
  /** The realpathed `--env-file` for the bin to read and delete; null when the caller gave none. */
  readonly envFile: string | null;
};

const inside = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/**
 * Check, resolve symlinks, and return the full argv to run (jail prefix + command) plus the env file to consume.
 * The `dozebox-jail-exec` bin execs it, or spawns it with inherited stdio and exits with its code.
 */
export async function resolveJailExec(deps: JailExecDeps, argv: ReadonlyArray<string>): Promise<JailExecPlan> {
  if (!deps.config.enabled) throw new RunnerError("invalid_input", false, "jail exec: the jail is off on this box");
  const args = parseJailExecArgs(argv, deps.payload);
  const real = async (p: string): Promise<string> => payloadPath(await deps.realpath(p), deps.payload);
  const bindRw = await Promise.all(args.bindRw.map(real));
  const readOnly = await Promise.all(args.readOnly.map(real));
  const envFile = args.envFile === null ? null : await real(args.envFile);
  let chdir: string | undefined;
  if (args.chdir !== null) {
    const dir = await real(args.chdir);
    if (![...bindRw, ...readOnly].some((bind) => inside(dir, bind)))
      throw usage(`--chdir "${args.chdir}" is not inside a bind`);
    chdir = dir;
  }
  const run: JailRun = {
    bindRw,
    readOnly,
    context: args.context,
    decoy: deps.decoy,
    ...(chdir === undefined ? {} : { chdir }),
    ...(envFile === null ? {} : { envArgsFd: ENV_ARGS_FD }),
  };
  return { argv: [...jailArgv(deps.config, deps.payload, deps.agentUid, run), ...args.command], envFile };
}
