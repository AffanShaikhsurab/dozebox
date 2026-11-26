// A3: the sudo rights a payload user has, read from `sudo -ll -U <user>`. A payload that opts out of
// NoNewPrivileges may have exactly one right, the jail-exec rule; anything else is refused before it starts. The
// Ubuntu image gives `ubuntu` passwordless root through cloud-init, and the opt-out would otherwise restore it.
import { messageOf } from "../errors.ts";
import { JAIL_EXEC_BIN } from "../jail/index.ts";
import type { Exec, ExecResult } from "../ports/exec.ts";

export type SudoRight = {
  readonly runAsUsers: string;
  readonly runAsGroups: string | null;
  readonly options: string | null;
  readonly commands: ReadonlyArray<string>;
};

/** `sudo -ll -U <user>` -> one entry per matching sudoers rule. */
export function parseSudoRights(stdout: string): ReadonlyArray<SudoRight> {
  const out: SudoRight[] = [];
  let cur: { runAsUsers: string; runAsGroups: string | null; options: string | null; commands: string[] } | null = null;
  let inCommands = false;
  const flush = (): void => {
    if (cur !== null) out.push({ ...cur, commands: [...cur.commands] });
    cur = null;
    inCommands = false;
  };
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("Sudoers entry:")) {
      flush();
      cur = { runAsUsers: "", runAsGroups: null, options: null, commands: [] };
      continue;
    }
    if (cur === null) continue;
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (inCommands) {
      if (/^\s/.test(line)) {
        cur.commands.push(line.trim());
        continue;
      }
      flush();
      continue;
    }
    const field = /^\s*(RunAsUsers|RunAsGroups|Options|Commands):\s*(.*)$/.exec(line);
    if (field === null) continue;
    const key = field[1];
    const value = (field[2] ?? "").trim();
    if (key === "RunAsUsers") cur.runAsUsers = value;
    else if (key === "RunAsGroups") cur.runAsGroups = value;
    else if (key === "Options") cur.options = value;
    else {
      inCommands = true;
      if (value !== "") cur.commands.push(value);
    }
  }
  flush();
  return out;
}

/** True when the only right is `(root) NOPASSWD: <JAIL_EXEC_BIN> *`. */
export function isJailExecOnly(rights: ReadonlyArray<SudoRight>): boolean {
  const only = rights[0];
  if (rights.length !== 1 || only === undefined) return false;
  return (
    only.runAsUsers === "root" &&
    only.runAsGroups === null &&
    only.options === "!authenticate" &&
    only.commands.length === 1 &&
    only.commands[0] === `${JAIL_EXEC_BIN} *`
  );
}

export type SudoVerdict = { readonly ok: true } | { readonly ok: false; readonly detail: string };

const describe = (r: SudoRight): string => {
  const runAs = r.runAsGroups === null ? r.runAsUsers : `${r.runAsUsers} : ${r.runAsGroups}`;
  const tag = r.options === null ? "" : r.options === "!authenticate" ? "NOPASSWD: " : `${r.options} `;
  return `(${runAs}) ${tag}${r.commands.join(", ")}`;
};

/** Read the user's rights and accept only the jail-exec rule. A read that fails is a refusal, never a pass. */
export async function verifyJailSudo(exec: Exec, user: string, signal: AbortSignal): Promise<SudoVerdict> {
  let result: ExecResult;
  try {
    result = await exec.run(["sudo", "-ll", "-U", user], { signal });
  } catch (e) {
    return { ok: false, detail: `could not read the sudo rights of ${user}: ${messageOf(e)}` };
  }
  if (result.code !== 0) {
    return { ok: false, detail: `sudo -ll -U ${user} exited ${result.code}: ${result.stderr.trim().slice(0, 200)}` };
  }
  const rights = parseSudoRights(result.stdout);
  if (isJailExecOnly(rights)) return { ok: true };
  if (rights.length === 0) {
    return { ok: false, detail: `${user} has no sudo rights; the ${JAIL_EXEC_BIN} rule is missing (is the jail on?)` };
  }
  return { ok: false, detail: `${user} may run sudo beyond ${JAIL_EXEC_BIN}: ${rights.map(describe).join("; ")}` };
}
