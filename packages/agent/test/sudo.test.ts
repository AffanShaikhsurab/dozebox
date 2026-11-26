// supervisor/sudo.ts: the sudo rights a payload that opts out of NoNewPrivileges may have. The only accepted right is
// the jail-exec rule; the Ubuntu image's `ubuntu` user also has passwordless root, which must be refused.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeFakeExec } from "@dozebox/testkit/fakes";
import { isJailExecOnly, parseSudoRights, verifyJailSudo } from "../src/supervisor/sudo.ts";

const JAIL = "/opt/dozebox/current/bin/dozebox-jail-exec";

const HEAD = [
  "Matching Defaults entries for web on box:",
  "    env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin\\:/snap/bin, use_pty",
  "",
  "User web may run the following commands on box:",
  "",
];

const entry = (
  file: string,
  runAs: string,
  groups: string | null,
  options: string | null,
  commands: ReadonlyArray<string>,
): string[] => [
  `Sudoers entry: ${file}`,
  `    RunAsUsers: ${runAs}`,
  ...(groups === null ? [] : [`    RunAsGroups: ${groups}`]),
  ...(options === null ? [] : [`    Options: ${options}`]),
  "    Commands:",
  ...commands.map((c) => `\t${c}`),
  "",
];

const JAIL_ONLY = [...HEAD, ...entry("/etc/sudoers.d/dozebox", "root", null, "!authenticate", [`${JAIL} *`])].join(
  "\n",
);
const WITH_ROOT = [
  ...HEAD,
  ...entry("/etc/sudoers", "ALL", "ALL", null, ["ALL"]),
  ...entry("/etc/sudoers.d/90-cloud-init-users", "ALL", null, "!authenticate", ["ALL"]),
].join("\n");
const NOBODY = "User nobody is not allowed to run sudo on box.\n";

test("parses one right per sudoers entry", () => {
  assert.deepEqual(parseSudoRights(JAIL_ONLY), [
    { runAsUsers: "root", runAsGroups: null, options: "!authenticate", commands: [`${JAIL} *`] },
  ]);
  assert.deepEqual(parseSudoRights(WITH_ROOT), [
    { runAsUsers: "ALL", runAsGroups: "ALL", options: null, commands: ["ALL"] },
    { runAsUsers: "ALL", runAsGroups: null, options: "!authenticate", commands: ["ALL"] },
  ]);
  assert.deepEqual(parseSudoRights(NOBODY), []);
});

test("only the jail-exec rule is accepted", () => {
  assert.equal(isJailExecOnly(parseSudoRights(JAIL_ONLY)), true);
  assert.equal(isJailExecOnly(parseSudoRights(WITH_ROOT)), false);
  assert.equal(isJailExecOnly(parseSudoRights(NOBODY)), false);
  // A second command, a run-as group, or another option is not the rule.
  const extra = [
    ...HEAD,
    ...entry("/etc/sudoers.d/dozebox", "root", null, "!authenticate", [`${JAIL} *`, "/bin/bash"]),
  ];
  assert.equal(isJailExecOnly(parseSudoRights(extra.join("\n"))), false);
  const groups = [...HEAD, ...entry("/etc/sudoers.d/dozebox", "root", "root", "!authenticate", [`${JAIL} *`])];
  assert.equal(isJailExecOnly(parseSudoRights(groups.join("\n"))), false);
  const setenv = [...HEAD, ...entry("/etc/sudoers.d/dozebox", "root", null, "!authenticate, SETENV", [`${JAIL} *`])];
  assert.equal(isJailExecOnly(parseSudoRights(setenv.join("\n"))), false);
});

test("verifyJailSudo accepts the jail-exec rule", async () => {
  const exec = makeFakeExec([{ match: ["sudo", "-ll", "-U", "web"], outcome: { stdout: JAIL_ONLY } }]);
  assert.deepEqual(await verifyJailSudo(exec, "web", new AbortController().signal), { ok: true });
});

test("verifyJailSudo refuses a user with NOPASSWD:ALL", async () => {
  const exec = makeFakeExec([{ match: ["sudo", "-ll", "-U", "ubuntu"], outcome: { stdout: WITH_ROOT } }]);
  const verdict = await verifyJailSudo(exec, "ubuntu", new AbortController().signal);
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok && verdict.detail.includes("NOPASSWD: ALL"));
  assert.ok(!verdict.ok && verdict.detail.includes("(ALL : ALL) ALL"));
});

test("verifyJailSudo refuses a user with no sudo rights", async () => {
  const exec = makeFakeExec([{ match: ["sudo", "-ll", "-U", "nobody"], outcome: { stdout: NOBODY } }]);
  const verdict = await verifyJailSudo(exec, "nobody", new AbortController().signal);
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok && verdict.detail.includes("no sudo rights"));
});

test("verifyJailSudo refuses when sudo cannot be read", async () => {
  const missing = makeFakeExec([{ match: ["sudo"], outcome: { throws: new Error("ENOENT") } }]);
  const a = await verifyJailSudo(missing, "web", new AbortController().signal);
  assert.equal(a.ok, false);
  assert.ok(!a.ok && a.detail.includes("ENOENT"));

  const failed = makeFakeExec([{ match: ["sudo"], outcome: { code: 1, stderr: "unknown user web\n" } }]);
  const b = await verifyJailSudo(failed, "web", new AbortController().signal);
  assert.equal(b.ok, false);
  assert.ok(!b.ok && b.detail.includes("unknown user web"));
});
