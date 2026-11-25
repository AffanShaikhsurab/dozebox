// A3: the Linux users payloads run as. A payload's user gets home `/data/home/<user>`. With the jail on, the agents
// a payload launches run as `<payload>-agent`, a system user with uid >= AGENT_UID_MIN and a group whose gid equals
// the uid (agent-edge R5: `jailArgv` passes `--gid=<uid>` to systemd-run).
import { RunnerError } from "@dozebox/core/errors";
import type { Exec } from "../ports/exec.ts";

export const AGENT_UID_MIN = 60_000;
const AGENT_UID_MAX = 60_999;

export type PasswdEntry = { readonly name: string; readonly uid: number; readonly gid: number };

/** `/etc/passwd` text -> entries. */
export function parsePasswd(text: string): ReadonlyArray<PasswdEntry> {
  const out: PasswdEntry[] = [];
  for (const line of text.split("\n")) {
    const [name, , uid, gid] = line.split(":");
    if (!name || uid === undefined || gid === undefined) continue;
    const u = Number(uid);
    const g = Number(gid);
    if (Number.isInteger(u) && Number.isInteger(g)) out.push({ name, uid: u, gid: g });
  }
  return out;
}

async function must(exec: Exec, argv: ReadonlyArray<string>, signal: AbortSignal): Promise<void> {
  const r = await exec.run(argv, { signal });
  if (r.code !== 0) {
    throw new RunnerError("internal", false, `${argv.slice(0, 2).join(" ")}: exit ${r.code}: ${r.stderr.trim()}`);
  }
}

/** The payload's user, created when missing. */
export async function ensureUser(exec: Exec, user: string, signal: AbortSignal): Promise<void> {
  if ((await exec.run(["id", "-u", user], { signal })).code === 0) return;
  await must(
    exec,
    [
      "useradd",
      "--system",
      "--create-home",
      "--home-dir",
      `/data/home/${user}`,
      "--shell",
      "/bin/bash",
      "--user-group",
      user,
    ],
    signal,
  );
}

/** `<payload>-agent` with gid = uid, the first free id from AGENT_UID_MIN; returns its uid. */
export async function ensureAgentUser(
  deps: { readonly exec: Exec; readonly passwd: () => Promise<string> },
  payload: string,
  signal: AbortSignal,
): Promise<number> {
  const name = `${payload}-agent`;
  const entries = parsePasswd(await deps.passwd());
  const found = entries.find((e) => e.name === name);
  if (found) return found.uid;
  const used = new Set(entries.map((e) => e.uid));
  let uid = AGENT_UID_MIN;
  while (used.has(uid)) uid++;
  if (uid > AGENT_UID_MAX) throw new RunnerError("internal", false, `no free agent uid for ${name}`);
  // groupadd first: useradd --gid needs the group to exist.
  if ((await deps.exec.run(["getent", "group", String(uid)], { signal })).code !== 0) {
    await must(deps.exec, ["groupadd", "--system", "--gid", String(uid), name], signal);
  }
  await must(
    deps.exec,
    [
      "useradd",
      "--system",
      "--uid",
      String(uid),
      "--gid",
      String(uid),
      "--no-create-home",
      "--shell",
      "/usr/sbin/nologin",
      name,
    ],
    signal,
  );
  return uid;
}
