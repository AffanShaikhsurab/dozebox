// supervisor: install hooks, credentials, health checks and the systemd-backed PayloadSupervisor.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import type { PayloadDefinition } from "@dozebox/protocol/payload";
import { makeFakeClock, makeFakeExec, makeFakeFs, type ExecScript } from "@dozebox/testkit/fakes";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";
import { makeJsonLogger } from "../src/adapters/log.ts";
import {
  makeSupervisor,
  runHealthCheck,
  runInstallHook,
  writeCredentials,
  type SupervisorDeps,
  renderUnit,
} from "../src/supervisor/index.ts";

type Install = NonNullable<PayloadDefinition["install"]>;

const def = (over: Record<string, unknown> = {}): PayloadDefinition =>
  ({
    schema: 1,
    name: "web",
    user: "web",
    protocol: "none",
    start: { command: ["/usr/bin/web"] },
    ...over,
  }) as PayloadDefinition;
const install = (over: Partial<Install> = {}): Install => ({
  command: ["./setup.sh"],
  when: "on-change",
  timeoutSeconds: 60,
  ...over,
});

function world(files: Record<string, string> = {}) {
  const clock = makeFakeClock();
  const fake = makeFakeFs(files);
  const store = makeNodeFiles(fake.fs.promises as unknown as FsPromises, 1);
  return { clock, fake, files: store, log: makeJsonLogger(() => {}, clock.now) };
}
const marker = (w: ReturnType<typeof world>) => w.fake.snapshot()["/data/dozebox/payloads/web/install.json"];

// --- install hook ---

test("no install: nothing runs", async () => {
  const w = world();
  const exec = makeFakeExec([]);
  const out = await runInstallHook(
    { exec, files: w.files, stateDir: "/data/dozebox" },
    def(),
    new AbortController().signal,
  );
  assert.deepEqual(out, { ran: false, hash: "", code: null });
});

test("on-change runs once per hash and again after the hash changes", async () => {
  const w = world();
  const exec = makeFakeExec([{ match: ["runuser"], outcome: { code: 0 } }]);
  const d = { exec, files: w.files, stateDir: "/data/dozebox", clock: w.clock };
  const sig = new AbortController().signal;
  const a = await runInstallHook(d, def({ install: install() }), sig);
  const b = await runInstallHook(d, def({ install: install() }), sig);
  const c = await runInstallHook(d, def({ install: install({ command: ["./setup2.sh"] }) }), sig);
  assert.deepEqual([a.ran, b.ran, c.ran], [true, false, true]);
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
  assert.equal(JSON.parse(marker(w) ?? "{}").hash, c.hash);
  assert.deepEqual(exec.calls[0]?.argv, ["runuser", "-u", "web", "--", "./setup.sh"]);
  assert.equal(exec.calls[0]?.opts.cwd, "/data/payloads/web");
});

test("the hash ignores key order", async () => {
  const w = world();
  const exec = makeFakeExec([{ match: ["runuser"], outcome: {} }]);
  const d = { exec, files: w.files, stateDir: "/data/dozebox" };
  const sig = new AbortController().signal;
  const a = await runInstallHook(d, def({ install: { when: "on-change", timeoutSeconds: 60, command: ["x"] } }), sig);
  const b = await runInstallHook(d, def({ install: { command: ["x"], timeoutSeconds: 60, when: "on-change" } }), sig);
  assert.equal(a.hash, b.hash);
  assert.equal(b.ran, false);
});

test("once runs only without a marker; every-boot always runs", async () => {
  const w = world();
  const exec = makeFakeExec([{ match: ["runuser"], outcome: {} }]);
  const d = { exec, files: w.files, stateDir: "/data/dozebox" };
  const sig = new AbortController().signal;
  const once = def({ install: install({ when: "once" }) });
  assert.equal((await runInstallHook(d, once, sig)).ran, true);
  assert.equal((await runInstallHook(d, once, sig)).ran, false);
  const every = def({ name: "db", install: install({ when: "every-boot" }) });
  assert.equal((await runInstallHook(d, every, sig)).ran, true);
  assert.equal((await runInstallHook(d, every, sig)).ran, true);
});

test("a failed install writes no marker and reports the code; asRoot skips runuser", async () => {
  const w = world();
  const exec = makeFakeExec([{ match: ["./setup.sh"], outcome: { code: 3 } }]);
  const d = { exec, files: w.files, stateDir: "/data/dozebox" };
  const out = await runInstallHook(d, def({ install: install({ asRoot: true }) }), new AbortController().signal);
  assert.equal(out.ran, true);
  assert.equal(out.code, 3);
  assert.equal(marker(w), undefined);
  assert.deepEqual(exec.calls[0]?.argv, ["./setup.sh"]);
});

test("the install timeout aborts the command and leaves no marker", async () => {
  const w = world();
  const exec = makeFakeExec([{ match: ["runuser"], outcome: { hang: true } }]);
  const p = runInstallHook(
    { exec, files: w.files, stateDir: "/data/dozebox", clock: w.clock },
    def({ install: install({ timeoutSeconds: 10 }) }),
    new AbortController().signal,
  );
  for (let i = 0; i < 20; i++) await Promise.resolve();
  w.clock.advance(10_000);
  await assert.rejects(p, { name: "TimeoutError" });
  assert.equal(marker(w), undefined);
});

test("an aborted signal aborts the install", async () => {
  const w = world();
  const exec = makeFakeExec([{ match: ["runuser"], outcome: { hang: true } }]);
  const ac = new AbortController();
  const p = runInstallHook(
    { exec, files: w.files, stateDir: "/data/dozebox", clock: w.clock },
    def({ install: install() }),
    ac.signal,
  );
  ac.abort(new Error("shutdown"));
  await assert.rejects(p, /shutdown/);
});

// --- credentials ---

test("credentials: files, one env file, optional skipped", async () => {
  const w = world();
  const values: Record<string, string> = { a: "alpha", b: "beta", c: "gamma" };
  const names = await writeCredentials(
    { files: w.files, secret: async (n) => values[n] ?? null },
    def({
      secrets: [
        { name: "a", as: { file: "a.key" } },
        { name: "b", as: { env: "B_TOKEN" } },
        { name: "missing", as: { file: "m.key" }, optional: true },
        { name: "c", as: { env: "C_TOKEN" } },
        { name: "a", as: { file: "again.key" } },
      ],
    }),
  );
  assert.deepEqual(names, ["a.key", "again.key"]);
  const snap = w.fake.snapshot();
  assert.equal(snap["/run/dozebox/credentials/web/a.key"], "alpha");
  assert.equal(snap["/run/dozebox/credentials/web/env"], "B_TOKEN=beta\nC_TOKEN=gamma\n");
  assert.equal(snap["/run/dozebox/credentials/web/m.key"], undefined);
});

test("credentials: a missing required secret and a newline value are refused", async () => {
  const w = world();
  const secrets = [{ name: "tok", as: { file: "t" } }];
  await assert.rejects(
    writeCredentials({ files: w.files, secret: async () => null }, def({ secrets })),
    (e) => e instanceof RunnerError && e.code === "invalid_input" && e.message.includes("tok"),
  );
  await assert.rejects(
    writeCredentials(
      { files: w.files, secret: async () => "a\nb" },
      def({ secrets: [{ name: "tok", as: { env: "T" } }] }),
    ),
    (e) => e instanceof RunnerError && e.code === "invalid_input",
  );
});

// --- health ---

const res = (status: number) => new Response(null, { status });
const health = (over: Record<string, unknown>) => def({ health: over });
const sig = () => new AbortController().signal;

test("health http: ok, failing, expectStatus, throwing", async () => {
  const exec = makeFakeExec([]);
  const http = { url: "http://127.0.0.1:8080/" };
  const run = (status: number | Error, h: Record<string, unknown>) =>
    runHealthCheck(
      {
        exec,
        fetch: async () => {
          if (status instanceof Error) throw status;
          return res(status);
        },
      },
      health(h),
      sig(),
    );
  assert.deepEqual(await run(200, { http }), { name: "web", ok: true, detail: "HTTP 200" });
  assert.deepEqual(await run(302, { http }), { name: "web", ok: true, detail: "HTTP 302" });
  assert.equal((await run(500, { http })).ok, false);
  assert.equal((await run(404, { http: { ...http, expectStatus: 404 } })).ok, true);
  assert.equal((await run(200, { http: { ...http, expectStatus: 204 } })).ok, false);
  assert.deepEqual(await run(new Error("ECONNREFUSED"), { http }), { name: "web", ok: false, detail: "ECONNREFUSED" });
});

test("health command runs as the payload user", async () => {
  const exec = makeFakeExec([
    { match: ["runuser", "-u", "web", "--", "ok"], outcome: { code: 0 } },
    { match: ["runuser"], outcome: { code: 2, stderr: "x".repeat(300) } },
  ]);
  const d = { exec, fetch };
  assert.deepEqual(await runHealthCheck(d, health({ command: ["ok"] }), sig()), {
    name: "web",
    ok: true,
    detail: "exit 0",
  });
  const bad = await runHealthCheck(d, health({ command: ["bad"] }), sig());
  assert.equal(bad.ok, false);
  assert.ok(bad.detail.startsWith("exit 2: xxx") && bad.detail.length <= 200);
});

test("health timeout turns a hung check into a failure", async () => {
  const clock = makeFakeClock();
  const exec = makeFakeExec([{ match: ["runuser"], outcome: { hang: true } }]);
  const p = runHealthCheck({ exec, fetch, clock }, health({ command: ["x"], timeoutSeconds: 2 }), sig());
  clock.advance(2_000);
  assert.equal((await p).ok, false);
});

test("health without checks asks systemd", async () => {
  const unit = "dozebox-payload@web.service";
  const exec = makeFakeExec([
    { match: ["systemctl", "is-active", unit], outcome: { stdout: "active\n" }, times: 1 },
    { match: ["systemctl", "is-active", unit], outcome: { code: 3, stdout: "failed\n" } },
  ]);
  const d = { exec, fetch };
  assert.deepEqual(await runHealthCheck(d, def(), sig()), { name: "web", ok: true, detail: "active" });
  assert.deepEqual(await runHealthCheck(d, def(), sig()), { name: "web", ok: false, detail: "failed" });
});

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
