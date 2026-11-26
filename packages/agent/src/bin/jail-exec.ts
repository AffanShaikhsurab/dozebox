// `dozebox-jail-exec` (bin, run by a payload user through sudo): start an agent command in the payload's jail as
// `<payload>-agent`. The payload is the one whose user is SUDO_UID; the jail settings come from the last good config.
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastGoodPath } from "../config/load.ts";
import { parseLastGood } from "../config/parse.ts";
import { readEnv } from "../env.ts";
import { messageOf } from "../errors.ts";
import { ENV_ARGS_FD } from "../jail/bwrap.ts";
import { ENV_FILE_MAX_BYTES, envArgsContent, parseEnvFile, resolveJailExec } from "../jail/index.ts";
import { parsePasswd } from "../supervisor/users.ts";

const SHELL = "/bin/sh";
/**
 * Node marks every fd it opens close-on-exec, so an env-args fd cannot survive `process.execve`. `sh` can open one
 * that does, and it execs the jail argv, so no process stays between sudo and bwrap.
 */
const SHELL_OPEN_ENV = 'exec 3<"$1/args" || exit 2\nrm -rf -- "$1"\nshift\nexec "$@"';
const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/** Read the `--env-file` as root, delete it, and return the bwrap `--args` stream. */
async function takeEnvFile(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(ENV_FILE_MAX_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > ENV_FILE_MAX_BYTES)
        throw new Error(`dozebox-jail-exec: the env file is over ${ENV_FILE_MAX_BYTES} bytes`);
    }
    return envArgsContent(parseEnvFile(bytes.subarray(0, total)));
  } finally {
    await file.close();
    await unlink(path).catch(() => {});
  }
}

/** A root-only copy of the checked args for `sh` to open; the caller's file is already gone. */
async function writeEnvArgs(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dozebox-jail-env-"));
  await writeFile(join(dir, "args"), content, { mode: 0o600, flag: "wx" });
  return dir;
}

/** The fallback for a Node without `process.execve`: keep the child, forward the signals that stop a turn. */
function runChild(cmd: string, args: ReadonlyArray<string>, envArgs: string | null): Promise<number> {
  const child = spawn(cmd, args, {
    stdio: envArgs === null ? "inherit" : ["inherit", "inherit", "inherit", "pipe"],
  });
  if (envArgs !== null) (child.stdio[ENV_ARGS_FD] as NodeJS.WritableStream | null | undefined)?.end(envArgs);
  for (const signal of FORWARDED) process.on(signal, () => child.kill(signal));
  return new Promise((resolve) => child.once("close", (code) => resolve(code ?? 1)));
}

async function main(): Promise<number> {
  const env = readEnv(process.env, process.pid);
  const cfg = parseLastGood(await readFile(lastGoodPath(env.stateDir), "utf8"), env);
  if (!cfg.ok) throw new Error(cfg.problem);
  const users = parsePasswd(await readFile("/etc/passwd", "utf8"));
  const caller = users.find((u) => String(u.uid) === process.env["SUDO_UID"]);
  const def = cfg.value.payloads.find((p) => p.user === caller?.name);
  if (!def) throw new Error("dozebox-jail-exec: run it as a payload user through sudo");
  const agent = users.find((u) => u.name === `${def.name}-agent`);
  if (!agent) throw new Error(`dozebox-jail-exec: no user ${def.name}-agent`);
  const j = cfg.value.box.jail;
  const plan = await resolveJailExec(
    {
      realpath,
      config: {
        enabled: j.enabled && j.egress !== "off",
        egress: j.egress === "allowlist" ? "allowlist" : "imds-only",
        allowHosts: j.allowHosts,
      },
      payload: def.name,
      agentUid: agent.uid,
      decoy: cfg.value.box.tripwire.enabled,
    },
    process.argv.slice(2),
  );
  const [cmd, ...args] = plan.argv;
  if (cmd === undefined) throw new Error("dozebox-jail-exec: nothing to run");
  const envArgs = plan.envFile === null ? null : await takeEnvFile(plan.envFile);
  if (typeof process.execve === "function") {
    if (envArgs !== null) {
      const dir = await writeEnvArgs(envArgs);
      process.execve(SHELL, [SHELL, "-c", SHELL_OPEN_ENV, "dozebox-jail-exec", dir, cmd, ...args], process.env);
    }
    process.execve(cmd, [cmd, ...args], process.env);
  }
  return runChild(cmd, args, envArgs);
}

try {
  process.exitCode = await main();
} catch (e) {
  process.stderr.write(`${messageOf(e)}\n`);
  process.exitCode = 2;
}
