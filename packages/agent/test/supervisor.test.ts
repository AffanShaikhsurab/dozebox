// supervisor: the systemd-backed PayloadSupervisor (startAll, stopAll, restart, states, checkHealth).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import type { PayloadDefinition } from "@dozebox/protocol/payload";
import { makeFakeExec, type ExecScript } from "@dozebox/testkit/fakes";
import { makeSupervisor, renderUnit, type SupervisorDeps } from "../src/supervisor/index.ts";
import { def, install, sig, world } from "./supervisor-support.ts";

// --- supervisor ---

const UNIT = "dozebox-payload@web.service";
const fakeRender = (d: PayloadDefinition, o: { readonly credentials: ReadonlyArray<string> }) => ({
  unit: `dozebox-payload@${d.name}.service`,
  path: `/etc/systemd/system/dozebox-payload@${d.name}.service.d/10-dozebox.conf`,
  text: `[Service]\n# ${d.name} ${o.credentials.join(",")}\n`,
  hash: "h",
});

function supervisor(
  defs: PayloadDefinition[],
  scripts: ExecScript[] = [],
  opts: { files?: Record<string, string>; secret?: SupervisorDeps["secret"] } = {},
) {
  const w = world(opts.files);
  const exec = makeFakeExec([
    ...scripts,
    { match: ["id"], outcome: { code: 0 } },
    { match: ["useradd"], outcome: {} },
    { match: ["install", "-d"], outcome: {} },
    { match: ["runuser"], outcome: {} },
    { match: ["systemctl", "is-active"], outcome: { code: 3 } },
    { match: ["systemctl"], outcome: {} },
  ]);
  const deps: SupervisorDeps = {
    exec,
    files: w.files,
    log: w.log,
    fetch,
    stateDir: "/data/dozebox",
    payloads: () => defs,
    secret: opts.secret ?? (async () => null),
    execPrefix: [],
    boxId: "box-1",
    clock: w.clock,
    render: fakeRender as typeof renderUnit,
  };
  return { sup: makeSupervisor(deps), exec, w };
}
const verbs = (calls: ReturnType<typeof makeFakeExec>["calls"]) =>
  calls.map((c) => (c.argv[0] === "systemctl" ? `systemctl ${c.argv[1]}` : c.argv[0]));

test("startAll: user, dir, creds, drop-in, one daemon-reload, install, start", async () => {
  const web = def({ install: install(), secrets: [{ name: "k", as: { file: "k.key" } }] });
  const api = def({ name: "api", user: "api" });
  const { sup, exec, w } = supervisor([web, api], [{ match: ["id", "-u", "web"], outcome: { code: 1 }, times: 1 }], {
    secret: async () => "v",
  });
  await sup.startAll(sig());
  assert.deepEqual(verbs(exec.calls), [
    "id",
    "useradd",
    "install",
    "id",
    "install",
    "systemctl daemon-reload",
    "runuser",
    "systemctl is-active",
    "systemctl start",
    "systemctl is-active",
    "systemctl start",
  ]);
  assert.deepEqual(exec.calls[1]?.argv, [
    "useradd",
    "--system",
    "--create-home",
    "--home-dir",
    "/data/home/web",
    "--shell",
    "/bin/bash",
    "--user-group",
    "web",
  ]);
  assert.deepEqual(exec.calls[2]?.argv, [
    "install",
    "-d",
    "-o",
    "web",
    "-g",
    "web",
    "-m",
    "0750",
    "/data/payloads/web",
  ]);
  assert.equal(exec.calls.filter((c) => c.argv[1] === "daemon-reload").length, 1);
  const snap = w.fake.snapshot();
  assert.equal(snap["/run/dozebox/credentials/web/k.key"], "v");
  assert.equal(snap["/etc/systemd/system/dozebox-payload@web.service.d/10-dozebox.conf"], "[Service]\n# web k.key\n");
  assert.deepEqual(exec.calls[8]?.argv, ["systemctl", "start", UNIT]);
});

test("startAll again: no rewrite and no daemon-reload when the drop-in is unchanged", async () => {
  const { sup, exec } = supervisor([def()]);
  await sup.startAll(sig());
  const before = exec.calls.length;
  await sup.startAll(sig());
  assert.ok(!verbs(exec.calls.slice(before)).includes("systemctl daemon-reload"));
  assert.deepEqual(exec.calls.slice(before).at(-1)?.argv, ["systemctl", "start", UNIT]);
});

test("startAll restarts a unit whose drop-in changed while it is active", async () => {
  const path = "/etc/systemd/system/dozebox-payload@web.service.d/10-dozebox.conf";
  const { sup, exec } = supervisor([def()], [{ match: ["systemctl", "is-active"], outcome: { stdout: "active\n" } }], {
    files: { [path]: "[Service]\nold\n" },
  });
  await sup.startAll(sig());
  assert.deepEqual(exec.calls.at(-1)?.argv, ["systemctl", "restart", UNIT]);
});

test("startAll starts a changed unit that is not active", async () => {
  const { sup, exec } = supervisor([def()], [{ match: ["systemctl", "is-active"], outcome: { code: 3 } }]);
  await sup.startAll(sig());
  assert.deepEqual(exec.calls.at(-1)?.argv, ["systemctl", "start", UNIT]);
});

const SUDO_HEAD = [
  "Matching Defaults entries for web on box:",
  "    env_reset, mail_badpass",
  "",
  "User web may run the following commands on box:",
  "",
];
const SUDO_JAIL_ONLY = [
  ...SUDO_HEAD,
  "Sudoers entry: /etc/sudoers.d/dozebox",
  "    RunAsUsers: root",
  "    Options: !authenticate",
  "    Commands:",
  "\t/opt/dozebox/current/bin/dozebox-jail-exec *",
  "",
].join("\n");
const SUDO_WITH_ROOT = [
  ...SUDO_HEAD,
  "Sudoers entry: /etc/sudoers",
  "    RunAsUsers: ALL",
  "    RunAsGroups: ALL",
  "    Commands:",
  "\tALL",
  "",
  "Sudoers entry: /etc/sudoers.d/90-cloud-init-users",
  "    RunAsUsers: ALL",
  "    Options: !authenticate",
  "    Commands:",
  "\tALL",
  "",
].join("\n");

test("a payload that opts out of NoNewPrivileges starts when its only sudo right is jail-exec", async () => {
  const opted = def({ start: { command: ["/usr/bin/web"], noNewPrivileges: false } });
  const { sup, exec } = supervisor(
    [opted],
    [{ match: ["sudo", "-ll", "-U", "web"], outcome: { stdout: SUDO_JAIL_ONLY } }],
  );
  await sup.startAll(sig());
  assert.ok(exec.calls.some((c) => c.argv[1] === "start"));
});

test("a payload that opts out is refused when its user has any other sudo right", async () => {
  const opted = def({ start: { command: ["/usr/bin/web"], noNewPrivileges: false } });
  const { sup, exec } = supervisor(
    [opted],
    [{ match: ["sudo", "-ll", "-U", "web"], outcome: { stdout: SUDO_WITH_ROOT } }],
  );
  await assert.rejects(
    sup.startAll(sig()),
    (e) =>
      e instanceof RunnerError &&
      e.code === "invalid_input" &&
      e.message.includes("refusing to start") &&
      e.message.includes("NOPASSWD: ALL"),
  );
  assert.ok(!exec.calls.some((c) => c.argv[1] === "start"));
});

test("startAll stops on a failed install hook and starts nothing", async () => {
  const { sup, exec } = supervisor([def({ install: install() })], [{ match: ["runuser"], outcome: { code: 9 } }]);
  await assert.rejects(sup.startAll(sig()), (e) => e instanceof RunnerError && e.message.includes("web"));
  assert.ok(!exec.calls.some((c) => c.argv[1] === "start"));
});

test("a failing systemctl is a retryable internal RunnerError with its stderr", async () => {
  const { sup } = supervisor([def()], [{ match: ["systemctl", "start"], outcome: { code: 5, stderr: "boom\n" } }]);
  await assert.rejects(
    sup.startAll(sig()),
    (e) =>
      e instanceof RunnerError &&
      e.code === "internal" &&
      e.retryable &&
      e.message === `systemctl start ${UNIT}: exit 5: boom`,
  );
});

test("a payload dropped from the config is stopped, its drop-in stays", async () => {
  let defs = [def(), def({ name: "api", user: "api" })];
  const w = world();
  const exec = makeFakeExec([
    { match: ["id"], outcome: {} },
    { match: ["install"], outcome: {} },
    { match: ["systemctl", "is-active"], outcome: { code: 3 } },
    { match: ["systemctl"], outcome: {} },
  ]);
  const sup = makeSupervisor({
    exec,
    files: w.files,
    log: w.log,
    fetch,
    stateDir: "/data/dozebox",
    payloads: () => defs,
    secret: async () => null,
    execPrefix: [],
    boxId: "b",
    render: fakeRender as typeof renderUnit,
  });
  await sup.startAll(sig());
  defs = [def()];
  const before = exec.calls.length;
  await sup.startAll(sig());
  assert.deepEqual(exec.calls[before]?.argv, ["systemctl", "stop", "dozebox-payload@api.service"]);
  assert.ok(w.fake.snapshot()["/etc/systemd/system/dozebox-payload@api.service.d/10-dozebox.conf"]);
});

test("stopAll stops every unit in one call, kills when the signal aborts first", async () => {
  const two = [def(), def({ name: "api", user: "api" })];
  const a = supervisor(two);
  await a.sup.stopAll(sig());
  assert.deepEqual(
    a.exec.calls.map((c) => c.argv),
    [["systemctl", "stop", UNIT, "dozebox-payload@api.service"]],
  );

  const b = supervisor(two, [{ match: ["systemctl", "stop"], outcome: { hang: true } }]);
  const ac = new AbortController();
  const p = b.sup.stopAll(ac.signal);
  ac.abort(new Error("deadline"));
  await p;
  assert.deepEqual(b.exec.calls.at(-1)?.argv, [
    "systemctl",
    "kill",
    "--signal=SIGKILL",
    UNIT,
    "dozebox-payload@api.service",
  ]);
});

test("restart restarts the unit", async () => {
  const { sup, exec } = supervisor([def()]);
  await sup.restart("web", sig());
  assert.deepEqual(exec.calls[0]?.argv, ["systemctl", "restart", UNIT]);
});

test("states parses systemctl show blocks", async () => {
  const out = [
    "Id=dozebox-payload@web.service\nActiveState=active\nActiveEnterTimestamp=@1700000000\nNRestarts=2",
    "Id=dozebox-payload@api.service\nActiveState=wibble\nActiveEnterTimestamp=n/a\nNRestarts=0",
    "Id=dozebox-payload@db.service\nActiveState=failed\nActiveEnterTimestamp=\nNRestarts=",
  ].join("\n\n");
  const { sup, exec } = supervisor(
    [def(), def({ name: "api", user: "api" }), def({ name: "db", user: "db" })],
    [{ match: ["systemctl", "show"], outcome: { stdout: `${out}\n` } }],
  );
  assert.deepEqual(await sup.states(), [
    { name: "web", active: "active", activeSince: 1_700_000_000_000, restarts: 2 },
    { name: "api", active: "inactive", activeSince: null, restarts: 0 },
    { name: "db", active: "failed", activeSince: null, restarts: 0 },
  ]);
  assert.equal(exec.calls.length, 1);
  assert.deepEqual(exec.calls[0]?.argv.slice(0, 4), [
    "systemctl",
    "show",
    "--timestamp=unix",
    "--property=Id,ActiveState,ActiveEnterTimestamp,NRestarts",
  ]);
});

test("checkHealth returns one result per payload in definition order", async () => {
  const { sup } = supervisor(
    [def(), def({ name: "api", user: "api" })],
    [
      { match: ["systemctl", "is-active", UNIT], outcome: { stdout: "active\n" } },
      { match: ["systemctl", "is-active"], outcome: { code: 3, stdout: "inactive\n" } },
    ],
  );
  assert.deepEqual(await sup.checkHealth(sig()), [
    { name: "web", ok: true, detail: "active" },
    { name: "api", ok: false, detail: "inactive" },
  ]);
});
