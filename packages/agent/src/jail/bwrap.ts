// A8: the bubblewrap argv for a jailed agent (part 8 §8.4). Deny by default: only /usr, a few /etc files, a private
// /tmp, /proc, /dev and the work paths the payload names are visible. /run/dozebox, /data/dozebox, /etc/dozebox,
// /opt/dozebox and every home stay out because they are never bound.
import type { JailConfig } from "./types.ts";

export const BWRAP = "/usr/bin/bwrap";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const ENV = "/usr/bin/env";
export const DECOY_CONFIG = "/etc/dozebox/aws-decoy.config";
const JAIL_PATH = "/usr/local/bin:/usr/bin:/bin";
/** The fd `--args` reads the `--env-file` pairs from; the bin opens it, so the values never reach argv. */
export const ENV_ARGS_FD = 3;

export type JailRun = {
  /** Read-write binds, each under `/data/payloads/<payload>/` (checked by `parseJailExecArgs`). */
  readonly bindRw?: ReadonlyArray<string>;
  readonly readOnly?: ReadonlyArray<string>;
  /** The `--context` the payload passed; the tripwire pages with it. */
  readonly context?: string;
  /** Bind the decoy AWS profile and point AWS_CONFIG_FILE at it (default on). */
  readonly decoy?: boolean;
  /** Where the command starts; defaults to the first read-write bind. */
  readonly chdir?: string;
  /** Read extra bwrap arguments (`--setenv` pairs) from this inherited fd. */
  readonly envArgsFd?: number;
};

const ETC_FILES = ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group"];
const ETC_DIRS = ["/etc/ssl", "/etc/ca-certificates", "/etc/alternatives"];

/** The bwrap flags alone (no program). `--unshare-user` is explicit: `--unshare-all` skips it silently on failure. */
export function bwrapFlags(run: JailRun = {}): string[] {
  const rw = run.bindRw ?? [];
  const flags = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--die-with-parent",
    "--new-session",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
  ];
  for (const f of ETC_FILES) flags.push("--ro-bind-try", f, f);
  for (const d of ETC_DIRS) flags.push("--ro-bind-try", d, d);
  flags.push("--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev");
  for (const p of run.readOnly ?? []) flags.push("--ro-bind", p, p);
  for (const p of rw) flags.push("--bind", p, p);
  flags.push("--clearenv", "--setenv", "PATH", JAIL_PATH, "--setenv", "HOME", "/tmp", "--setenv", "LANG", "C.UTF-8");
  // After the defaults so the env file's HOME wins over /tmp, before the context and the decoy so it cannot spoof them.
  if (run.envArgsFd !== undefined) flags.push("--args", String(run.envArgsFd));
  if (run.context !== undefined) flags.push("--setenv", "DOZEBOX_CONTEXT", run.context);
  if (run.decoy ?? true)
    flags.push("--ro-bind-try", DECOY_CONFIG, DECOY_CONFIG, "--setenv", "AWS_CONFIG_FILE", DECOY_CONFIG);
  const chdir = run.chdir ?? rw[0];
  if (chdir !== undefined) flags.push("--chdir", chdir);
  return flags;
}

/**
 * The argv prefix that runs a command as the payload's agent user inside the jail, in the payload's agents slice
 * (`dozebox-agents-<payload>.slice`, child of `dozebox-agents.slice`), so a fork bomb hits that slice's limits.
 * `env -i` first: bwrap's own environ is readable as /proc/1/environ inside the jail, so it must not carry the caller's.
 * Empty when the jail is off.
 */
export function jailArgv(cfg: JailConfig, payload: string, uid: number, run: JailRun = {}): ReadonlyArray<string> {
  if (!cfg.enabled) return [];
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(payload)) throw new TypeError(`"${payload}" is not a payload name`);
  if (!Number.isInteger(uid) || uid < 60_000) throw new TypeError(`agent uid ${uid} is below 60000`);
  return [
    SYSTEMD_RUN,
    "--scope",
    "--quiet",
    "--collect",
    `--slice=dozebox-agents-${payload}.slice`,
    `--uid=${uid}`,
    `--gid=${uid}`,
    "--",
    ENV,
    "-i",
    BWRAP,
    ...bwrapFlags(run),
    "--",
  ];
}
