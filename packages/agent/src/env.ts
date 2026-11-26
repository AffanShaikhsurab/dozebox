// The agent's environment, set by `dozeboxd.service` (rendered by stage 0) and by systemd itself. Checked once at
// start: a bad value is a deployment bug, so it throws and systemd shows the message.

export type AgentEnv = {
  readonly boxId: string;
  readonly prefix: string;
  /** Null: the region from IMDS. */
  readonly region: string | null;
  /** Where the agent keeps its state (last good config, holds, wakes). Default `/data/dozebox`. */
  readonly stateDir: string;
  readonly imdsUrl: string;
  /** Set by systemd for `Type=notify` units; absent when run by hand. */
  readonly notifySocket: string | undefined;
  /** Half of `WATCHDOG_USEC` (sd_watchdog_enabled's advice), or null when systemd has no watchdog for the unit. */
  readonly watchdogEveryMs: number | null;
};

const BOX_ID = /^[a-z0-9][a-z0-9-]{0,19}$/;
const PREFIX = /^[a-z][a-z0-9-]{0,20}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export type Env = Readonly<Record<string, string | undefined>>;

const unquote = (v: string): string => {
  const q = v[0];
  return v.length >= 2 && (q === '"' || q === "'") && v.endsWith(q) ? v.slice(1, -1) : v;
};

/** Pure: the `DOZEBOX_*` keys of `/etc/dozebox/box.env`, the root-owned file stage 0 writes. */
export function parseBoxEnv(text: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.startsWith("DOZEBOX_")) out[key] = unquote(line.slice(eq + 1).trim());
  }
  return out;
}

/**
 * The box identity from the root-owned box.env wins over the caller's env: a payload user runs jail-exec through
 * sudo and must not be able to point it at another box's last-good config.
 */
export function withBoxEnv(env: Env, boxEnv: Env): Env {
  return { ...env, ...boxEnv };
}

const BOX_ENV_FILE = "/etc/dozebox/box.env";

/** What `lstat` must report for box.env to be trusted: a root-owned regular file no one else can write. */
export type BoxEnvStat = {
  readonly uid: number;
  readonly mode: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

export type BoxEnvDeps = {
  readonly lstat: (path: string) => Promise<BoxEnvStat>;
  readonly readFile: (path: string) => Promise<string>;
};

const errno = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? ` (${code})` : "";
};

const refuseBoxEnv = (why: string): Error => new Error(`dozebox-jail-exec: ${BOX_ENV_FILE} ${why}`);

/**
 * The env jail-exec runs with. Through sudo the caller's environment is untrusted, so box.env must be a root-owned
 * regular file that no one else can write, and it alone supplies the box identity; a missing or unreadable file is a
 * refusal, never a fallback. A direct root run with no SUDO_UID may fall back to its own environment.
 */
export async function loadBoxEnv(deps: BoxEnvDeps, env: Env): Promise<Env> {
  const sudo = (env["SUDO_UID"] ?? "") !== "";
  let st: BoxEnvStat;
  try {
    st = await deps.lstat(BOX_ENV_FILE);
  } catch (e) {
    if (sudo) throw refuseBoxEnv(`is missing${errno(e)}; refusing to run through sudo without it`);
    return env;
  }
  if (st.isSymbolicLink() || !st.isFile()) throw refuseBoxEnv("is not a regular file");
  if (st.uid !== 0) throw refuseBoxEnv(`is owned by uid ${st.uid}, not root`);
  if ((st.mode & 0o022) !== 0)
    throw refuseBoxEnv(`is group- or world-writable (mode ${(st.mode & 0o7777).toString(8)})`);
  let text: string;
  try {
    text = await deps.readFile(BOX_ENV_FILE);
  } catch (e) {
    if (sudo) throw refuseBoxEnv(`cannot be read${errno(e)}; refusing to run through sudo without it`);
    return env;
  }
  return withBoxEnv(sudo ? {} : env, parseBoxEnv(text));
}

function pick(env: Env, name: string, re: RegExp, fallback?: string): string {
  const v = env[name] || fallback;
  if (v === undefined) throw new Error(`${name} is not set`);
  if (!re.test(v)) throw new Error(`${name}="${v}" does not match ${re.source}`);
  return v;
}

function watchdogEvery(env: Env, pid: number): number | null {
  const usec = env["WATCHDOG_USEC"];
  if (!usec) return null;
  // WATCHDOG_PID, when set, names the process systemd watches; a child (such as a test runner) must not ping.
  const watched = env["WATCHDOG_PID"];
  if (watched && watched !== String(pid)) return null;
  const n = Number(usec);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`WATCHDOG_USEC="${usec}" is not a positive integer`);
  return Math.max(1, Math.floor(n / 2_000));
}

/** `pid` is this process's id, compared with WATCHDOG_PID. */
export function readEnv(env: Env, pid: number): AgentEnv {
  const region = env["DOZEBOX_REGION"];
  return {
    boxId: pick(env, "DOZEBOX_BOX_ID", BOX_ID),
    prefix: pick(env, "DOZEBOX_PREFIX", PREFIX, "dozebox"),
    region: region ? pick(env, "DOZEBOX_REGION", REGION) : null,
    stateDir: pick(env, "DOZEBOX_STATE_DIR", /^\/\S*[^/]$/, "/data/dozebox"),
    imdsUrl: pick(env, "DOZEBOX_IMDS_URL", /^http:\/\/\S+$/, "http://169.254.169.254"),
    notifySocket: env["NOTIFY_SOCKET"] || undefined,
    watchdogEveryMs: watchdogEvery(env, pid),
  };
}
