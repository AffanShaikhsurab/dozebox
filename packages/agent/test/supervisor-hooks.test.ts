// supervisor: install hooks, credentials and health checks.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeClock, makeFakeExec } from "@dozebox/testkit/fakes";
import { runHealthCheck, runInstallHook, writeCredentials } from "../src/supervisor/index.ts";
import { def, install, marker, sig, world } from "./supervisor-support.ts";

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
  const signal = new AbortController().signal;
  const a = await runInstallHook(d, def({ install: install() }), signal);
  const b = await runInstallHook(d, def({ install: install() }), signal);
  const c = await runInstallHook(d, def({ install: install({ command: ["./setup2.sh"] }) }), signal);
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
  const signal = new AbortController().signal;
  const a = await runInstallHook(
    d,
    def({ install: { when: "on-change", timeoutSeconds: 60, command: ["x"] } }),
    signal,
  );
  const b = await runInstallHook(
    d,
    def({ install: { command: ["x"], timeoutSeconds: 60, when: "on-change" } }),
    signal,
  );
  assert.equal(a.hash, b.hash);
  assert.equal(b.ran, false);
});

test("once runs only without a marker; every-boot always runs", async () => {
  const w = world();
  const exec = makeFakeExec([{ match: ["runuser"], outcome: {} }]);
  const d = { exec, files: w.files, stateDir: "/data/dozebox" };
  const signal = new AbortController().signal;
  const once = def({ install: install({ when: "once" }) });
  assert.equal((await runInstallHook(d, once, signal)).ran, true);
  assert.equal((await runInstallHook(d, once, signal)).ran, false);
  const every = def({ name: "db", install: install({ when: "every-boot" }) });
  assert.equal((await runInstallHook(d, every, signal)).ran, true);
  assert.equal((await runInstallHook(d, every, signal)).ran, true);
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
