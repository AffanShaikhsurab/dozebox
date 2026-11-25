// A8 real-system jail tests (spec 06-security 8.4). Needs an Ubuntu 24.04 host, root, bubblewrap and nftables; run with
// DOZEBOX_JAIL_TESTS=1 as root. Everywhere else the suite is skipped.
import assert from "node:assert/strict";
import { execFile, type ExecFileException } from "node:child_process";
import fsp from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createUnixServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeNodeExec } from "../src/adapters/exec.ts";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";
import { jailArgv } from "../src/jail/bwrap.ts";
import { renderNftRules } from "../src/jail/egress.ts";
import { APPARMOR_PROFILE, jailReadiness, renderAppArmorProfile } from "../src/jail/ready.ts";
import type { JailConfig } from "../src/jail/types.ts";

const ENABLED = process.env["DOZEBOX_JAIL_TESTS"] === "1" && process.getuid?.() === 0;
const SKIP = ENABLED ? false : "set DOZEBOX_JAIL_TESTS=1 and run as root on an Ubuntu 24.04 host";

const UID = 60_999;
const USER = "dz-test-agent";
const WORK = "/data/payloads/dztest/work";
const CRED_DIR = "/run/dz-test";
const CRED = `${CRED_DIR}/cred`;
const SOCK_DIR = "/run/dozebox/payloads";
const SOCK = `${SOCK_DIR}/dztest.sock`;
const CANARY = "dz-canary-9f3a71";
const IMDS_ONLY: JailConfig = { enabled: true, egress: "imds-only", allowHosts: [] };
const ALLOWLIST: JailConfig = { enabled: true, egress: "allowlist", allowHosts: [] };

type Out = { readonly code: number; readonly stdout: string; readonly stderr: string };

const sh = (file: string, args: ReadonlyArray<string>, input?: string): Promise<Out> =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      { timeout: 60_000, env: { ...process.env, DZ_CANARY: CANARY } },
      (err: ExecFileException | null, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : -1;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end(input ?? "");
  });

const must = async (file: string, args: ReadonlyArray<string>): Promise<void> => {
  const r = await sh(file, args);
  assert.equal(r.code, 0, `${file} ${args.join(" ")}: ${r.stderr}`);
};

const jail = async (probe: string, cfg: JailConfig = IMDS_ONLY): Promise<Out> => {
  const argv = jailArgv(cfg, "dztest", UID, { bindRw: [WORK], context: "t1", decoy: false });
  const [file, ...rest] = argv;
  assert.ok(file !== undefined);
  const r = await sh(file, [...rest, "/bin/sh", "-c", `echo DZ_ALIVE >&2; ${probe}`]);
  assert.ok(r.stderr.includes("DZ_ALIVE"), `the jail did not start: ${r.stderr}`);
  return r;
};

const loadRules = async (cfg: JailConfig): Promise<void> => {
  const file = join(tmpdir(), `dz-egress-${process.pid}.nft`);
  await fsp.writeFile(file, renderNftRules(cfg, [UID], []));
  try {
    await must("nft", ["-f", file]);
  } finally {
    await fsp.rm(file, { force: true });
  }
};

const dropTable = async (): Promise<void> => {
  await sh("nft", ["delete", "table", "inet", "dozebox_egress"]);
};

const exists = (p: string): Promise<boolean> =>
  fsp.access(p).then(
    () => true,
    () => false,
  );

describe("jail escapes on a real host", { skip: SKIP }, () => {
  let sock: NetServer | null = null;
  let loopback: Server | null = null;
  let loopbackPort = 0;
  let madeUser = false;
  let madeProfile = false;
  let madeDataRoot = false;
  let madeDozebox: string | null = null;
  let internet = false;

  before(async () => {
    const id = await sh("id", ["-u", USER]);
    if (id.code !== 0) {
      await must("groupadd", ["--gid", String(UID), USER]);
      await must("useradd", [
        "--system",
        "--uid",
        String(UID),
        "--gid",
        String(UID),
        "--no-create-home",
        "--shell",
        "/usr/sbin/nologin",
        USER,
      ]);
      madeUser = true;
    }
    await fsp.mkdir(WORK, { recursive: true });
    await must("chown", ["-R", `${UID}:${UID}`, "/data/payloads/dztest"]);
    madeDataRoot = !(await exists("/data/dozebox"));
    await fsp.mkdir("/data/dozebox", { recursive: true, mode: 0o755 });

    await fsp.mkdir(CRED_DIR, { recursive: true, mode: 0o700 });
    await fsp.writeFile(CRED, "SECRET", { mode: 0o600 });

    madeDozebox = (await fsp.mkdir(SOCK_DIR, { recursive: true, mode: 0o755 })) ?? null;
    await fsp.rm(SOCK, { force: true });
    sock = createUnixServer((c) => c.end("pong"));
    await new Promise<void>((r) => sock?.listen(SOCK, r));
    await fsp.chmod(SOCK, 0o600);

    loopback = createServer((_req, res) => res.end("loopback-ok"));
    await new Promise<void>((r) => loopback?.listen(0, "127.0.0.1", r));
    const addr = loopback.address();
    loopbackPort = typeof addr === "object" && addr !== null ? addr.port : 0;

    if (!(await exists(APPARMOR_PROFILE))) {
      await fsp.writeFile(APPARMOR_PROFILE, renderAppArmorProfile());
      madeProfile = true;
    }
    await must("apparmor_parser", ["-r", APPARMOR_PROFILE]);
    await loadRules(IMDS_ONLY);
    internet = (await sh("curl", ["-s", "-m", "5", "-o", "/dev/null", "https://example.com"])).code === 0;
  });

  after(async () => {
    await dropTable();
    await new Promise<void>((r) => (sock === null ? r() : sock.close(() => r())));
    await new Promise<void>((r) => (loopback === null ? r() : loopback.close(() => r())));
    await fsp.rm(SOCK, { force: true });
    if (madeDozebox !== null) await fsp.rm(madeDozebox, { recursive: true, force: true });
    await fsp.rm(CRED_DIR, { recursive: true, force: true });
    await fsp.rm("/data/payloads/dztest", { recursive: true, force: true });
    if (madeDataRoot) await fsp.rm("/data/dozebox", { recursive: true, force: true });
    if (madeProfile) {
      await sh("apparmor_parser", ["-R", APPARMOR_PROFILE]);
      await fsp.rm(APPARMOR_PROFILE, { force: true });
    }
    if (madeUser) {
      await sh("userdel", [USER]);
      await sh("groupdel", [USER]);
    }
  });

  describe("escapes fail", () => {
    it("cannot read a payload credential outside the binds", async () => {
      assert.ok(await exists(CRED));
      const r = await jail(`cat ${CRED} && echo LEAK`);
      assert.notEqual(r.code, 0);
      assert.ok(!r.stdout.includes("SECRET") && !r.stdout.includes("LEAK"), r.stdout);
    });

    it("cannot read root's or any home directory", async () => {
      const r = await jail("cat /root/.profile; ls /root /home /home/ubuntu 2>&1; echo END");
      assert.ok(!r.stdout.includes("PROFILE") && !r.stdout.includes("bashrc"), r.stdout);
      const probe = await jail("ls /root >/dev/null 2>&1 && echo LEAK; ls /home/ubuntu >/dev/null 2>&1 && echo LEAK");
      assert.ok(!probe.stdout.includes("LEAK"), probe.stdout);
    });

    it("cannot reach instance metadata over IPv4 or IPv6", async () => {
      const v4 = await jail("curl -s -m 3 http://169.254.169.254/latest/meta-data/");
      assert.notEqual(v4.code, 0);
      assert.equal(v4.stdout, "");
      const v6 = await jail("curl -s -m 3 -g 'http://[fd00:ec2::254]/latest/meta-data/'");
      assert.notEqual(v6.code, 0);
      assert.equal(v6.stdout, "");
    });

    it("cannot connect to the runner socket (/run/dozebox does not exist inside)", async () => {
      assert.ok(await exists(SOCK));
      const r = await jail(`test -e /run/dozebox && echo VISIBLE; curl -s -m 3 --unix-socket ${SOCK} http://x/`);
      assert.ok(!r.stdout.includes("VISIBLE") && !r.stdout.includes("pong"), r.stdout);
      assert.notEqual(r.code, 0);
    });

    it("cannot write to /data/dozebox", async () => {
      const r = await jail("touch /data/dozebox/pwn && echo LEAK");
      assert.notEqual(r.code, 0);
      assert.ok(!r.stdout.includes("LEAK"), r.stdout);
      assert.deepEqual(await fsp.readdir("/data/dozebox"), []);
    });

    it("cannot gain privileges with sudo or su", async () => {
      const sudo = await jail("sudo -n true && echo ROOT");
      assert.notEqual(sudo.code, 0);
      assert.ok(!sudo.stdout.includes("ROOT"), sudo.stdout);
      const su = await jail("su root -c 'echo ROOT' < /dev/null");
      assert.notEqual(su.code, 0);
      assert.ok(!su.stdout.includes("ROOT"), su.stdout);
      const status = await jail("grep NoNewPrivs /proc/self/status");
      assert.match(status.stdout, /NoNewPrivs:\s*1/);
    });

    it("sees only its own processes and no host environ", async () => {
      const pids = await jail("ls /proc | grep -E '^[0-9]+$'");
      const seen = pids.stdout.split("\n").filter((l) => l !== "");
      assert.ok(seen.length > 0 && seen.length < 10, `pids: ${seen.join(",")}`);
      assert.ok(!seen.includes(String(process.pid)), `host pid ${process.pid} visible`);
      assert.ok(!seen.includes(String(process.ppid)), `host ppid ${process.ppid} visible`);
      const one = await jail("cat /proc/1/environ | tr '\\0' '\\n'");
      assert.ok(!one.stdout.includes(CANARY), "host environment visible in /proc/1/environ");
      const all = await jail("for f in /proc/[0-9]*/environ; do cat $f 2>/dev/null | tr '\\0' '\\n'; done");
      assert.ok(!all.stdout.includes(CANARY), "host environment visible in some /proc/*/environ");
      assert.ok(!all.stdout.includes("SSH_"), "host environment visible in some /proc/*/environ");
    });

    it("cannot signal or read memory of a host process", async () => {
      const kill = await jail(`kill -0 ${process.pid} && echo LEAK`);
      assert.notEqual(kill.code, 0);
      assert.ok(!kill.stdout.includes("LEAK"), kill.stdout);
      const mem = await jail(`head -c 16 /proc/${process.pid}/mem >/dev/null && echo LEAK`);
      assert.notEqual(mem.code, 0);
      assert.ok(!mem.stdout.includes("LEAK"), mem.stdout);
    });
  });

  describe("the jail works", () => {
    it("writes in the work dir as the agent uid", async () => {
      const r = await jail(`echo hi > ${WORK}/f && cat ${WORK}/f`);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), "hi");
      assert.equal((await fsp.stat(`${WORK}/f`)).uid, UID);
    });

    it("reaches loopback and, in imds-only mode, the internet", async (t) => {
      const lo = await jail(`curl -s -m 3 http://127.0.0.1:${loopbackPort}/`);
      assert.equal(lo.stdout, "loopback-ok");
      if (!internet) return t.skip("B1 has no outbound internet");
      const r = await jail("curl -s -m 5 https://example.com -o /dev/null -w %{http_code}");
      assert.equal(r.stdout, "200");
    });
  });

  describe("allowlist egress with an empty allow set", () => {
    before(() => loadRules(ALLOWLIST));
    after(() => loadRules(IMDS_ONLY));

    it("blocks the internet but keeps loopback", async () => {
      const net = await jail("curl -s -m 3 https://example.com -o /dev/null -w %{http_code}", ALLOWLIST);
      assert.notEqual(net.code, 0);
      assert.ok(!net.stdout.includes("200"), net.stdout);
      const lo = await jail(`curl -s -m 3 http://127.0.0.1:${loopbackPort}/`, ALLOWLIST);
      assert.equal(lo.stdout, "loopback-ok");
    });

    it("still blocks instance metadata", async () => {
      const r = await jail("curl -s -m 3 http://169.254.169.254/latest/meta-data/", ALLOWLIST);
      assert.notEqual(r.code, 0);
      assert.equal(r.stdout, "");
    });
  });

  describe("jailReadiness with the real adapters", () => {
    it("is ready when bwrap, the profile and the table exist, and reports nftables once the table is gone", async () => {
      await loadRules(IMDS_ONLY);
      const deps = { exec: makeNodeExec(), files: makeNodeFiles(fsp as unknown as FsPromises) };
      const cfg = { ...IMDS_ONLY, tripwire: false };
      const ok = await jailReadiness(deps, cfg, new AbortController().signal);
      assert.deepEqual(ok, { ready: true, egress: "imds-only", missing: [] });
      await dropTable();
      const gone = await jailReadiness(deps, cfg, new AbortController().signal);
      assert.equal(gone.ready, false);
      assert.deepEqual(gone.missing, ["nftables"]);
    });
  });
});
