import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeExec, makeFakeFs } from "@dozebox/testkit/fakes";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";
import { jailArgv } from "../src/jail/bwrap.ts";
import {
  ENV_FILE_MAX_BYTES,
  envArgsContent,
  parseEnvFile,
  parseJailExecArgs,
  resolveJailExec,
} from "../src/jail/exec.ts";
import { APPARMOR_PROFILE, jailReadiness, renderAppArmorProfile } from "../src/jail/ready.ts";
import type { JailConfig } from "../src/jail/types.ts";

const ON: JailConfig = { enabled: true, egress: "imds-only", allowHosts: [] };
const WORK = "/data/payloads/web/work/t-1";

const bad = (argv: string[]) => assert.throws(() => parseJailExecArgs(argv, "web"), RunnerError, argv.join(" "));
const files = (seed: Record<string, string>) => makeNodeFiles(makeFakeFs(seed).fs.promises as unknown as FsPromises, 1);

const pairs = (argv: ReadonlyArray<string>, flag: string): string[] =>
  argv.flatMap((a, i) => (a === flag ? [argv[i + 1] ?? ""] : []));

const deps = (realpath: (p: string) => Promise<string> = async (p) => p) => ({
  realpath,
  config: ON,
  payload: "web",
  agentUid: 60_001,
  decoy: true,
});

const parse = (text: string) => parseEnvFile(Buffer.from(text));

describe("jailArgv", () => {
  it("is empty when the jail is off", () => {
    assert.deepEqual(jailArgv({ ...ON, enabled: false }, "web", 60_001), []);
  });

  it("runs bwrap as the agent uid in the payload's agents slice, ending with --", () => {
    const argv = jailArgv(ON, "web", 60_001, { bindRw: [WORK], context: "thread-9" });
    assert.deepEqual(argv.slice(0, 8), [
      "/usr/bin/systemd-run",
      "--scope",
      "--quiet",
      "--collect",
      "--slice=dozebox-agents-web.slice",
      "--uid=60001",
      "--gid=60001",
      "--",
    ]);
    assert.deepEqual(argv.slice(8, 11), ["/usr/bin/env", "-i", "/usr/bin/bwrap"]);
    assert.equal(argv.at(-1), "--");
  });

  it("unshares the user namespace explicitly and never --unshare-all or --unshare-net", () => {
    const argv = jailArgv(ON, "web", 60_001);
    for (const f of [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
    ]) {
      assert.ok(argv.includes(f), f);
    }
    assert.ok(!argv.includes("--unshare-all"));
    assert.ok(!argv.includes("--unshare-net"), "agents need the network; egress rules apply instead");
  });

  it("binds only the work paths read-write and nothing of the runner's", () => {
    const argv = jailArgv(ON, "web", 60_001, { bindRw: [WORK] });
    assert.deepEqual(pairs(argv, "--bind"), [WORK]);
    const all = argv.join(" ");
    for (const hidden of ["/run/dozebox", "/data/dozebox", "/opt/dozebox", "/home", "/root", "/run/credentials"]) {
      assert.ok(!all.includes(hidden), hidden);
    }
    assert.equal(argv[argv.indexOf("--chdir") + 1], WORK);
  });

  it("passes the context and the decoy profile; the decoy can be turned off", () => {
    const argv = jailArgv(ON, "web", 60_001, { context: "thread-9" });
    assert.ok(argv.join(" ").includes("--setenv DOZEBOX_CONTEXT thread-9"));
    assert.ok(argv.join(" ").includes("--setenv AWS_CONFIG_FILE /etc/dozebox/aws-decoy.config"));
    assert.ok(!jailArgv(ON, "web", 60_001, { decoy: false }).includes("AWS_CONFIG_FILE"));
  });

  it("refuses a uid below 60000 and a bad payload name", () => {
    assert.throws(() => jailArgv(ON, "web", 1000), TypeError);
    assert.throws(() => jailArgv(ON, "../x", 60_001), TypeError);
  });
});

describe("jail exec arguments", () => {
  it("parses context, binds and the command", () => {
    assert.deepEqual(
      parseJailExecArgs(["--context", "t-1", "--bind-rw", `${WORK}/`, "--", "claude", "-p", "x"], "web"),
      {
        context: "t-1",
        bindRw: [WORK],
        readOnly: [],
        envFile: null,
        chdir: null,
        command: ["claude", "-p", "x"],
      },
    );
  });

  it("parses --env-file and --chdir", () => {
    assert.deepEqual(
      parseJailExecArgs(
        ["--context", "t-1", "--bind-rw", WORK, "--env-file", `${WORK}/e.env`, "--chdir", `${WORK}/sub`, "--", "sh"],
        "web",
      ),
      {
        context: "t-1",
        bindRw: [WORK],
        readOnly: [],
        envFile: `${WORK}/e.env`,
        chdir: `${WORK}/sub`,
        command: ["sh"],
      },
    );
  });

  it("refuses an env file or a chdir outside the payload's data dir", () => {
    bad(["--context", "c", "--env-file", "/data/dozebox/e", "--", "sh"]);
    bad(["--context", "c", "--env-file", "/data/payloads/api/e", "--", "sh"]);
    bad(["--context", "c", "--env-file", `${WORK}/../e`, "--", "sh"]);
    bad(["--context", "c", "--chdir", "/data/dozebox", "--", "sh"]);
    bad(["--context", "c", "--chdir", "/data/payloads/web", "--", "sh"]);
  });

  it("refuses paths outside the payload's data dir, .., relative paths and other payloads", () => {
    bad(["--context", "c", "--bind-rw", "/data/dozebox", "--", "sh"]);
    bad(["--context", "c", "--bind-rw", "/data/payloads/web/../../dozebox", "--", "sh"]);
    bad(["--context", "c", "--bind-rw", "data/payloads/web/x", "--", "sh"]);
    bad(["--context", "c", "--bind-rw", "/data/payloads/api/x", "--", "sh"]);
    bad(["--context", "c", "--bind-rw", "/data/payloads/web", "--", "sh"]);
    bad(["--context", "c", "--bind-rw", "/data/payloads/webx/y", "--", "sh"]);
  });

  it("needs a context, a command and known options", () => {
    bad(["--", "sh"]);
    bad(["--context", "c"]);
    bad(["--context", "c", "--"]);
    bad(["--context", "c d", "--", "sh"]);
    bad(["--context", "c", "--privileged", "x", "--", "sh"]);
    bad(["--context"]);
  });

  it("a symlink under the data dir that leads out is refused", async () => {
    const d = {
      realpath: async (p: string) => (p.endsWith("/link") ? "/data/dozebox" : p),
      config: ON,
      payload: "web",
      agentUid: 60_001,
      decoy: true,
    };
    const ok = await resolveJailExec(d, ["--context", "c", "--bind-rw", WORK, "--", "make"]);
    assert.equal(ok.argv.at(-1), "make");
    assert.equal(ok.envFile, null);
    await assert.rejects(
      resolveJailExec(d, ["--context", "c", "--bind-rw", `${WORK}/link`, "--", "make"]),
      RunnerError,
    );
    await assert.rejects(
      resolveJailExec(d, ["--context", "c", "--bind-rw", WORK, "--env-file", `${WORK}/link`, "--", "make"]),
      RunnerError,
    );
    await assert.rejects(
      resolveJailExec(d, ["--context", "c", "--bind-rw", WORK, "--chdir", `${WORK}/link`, "--", "make"]),
      RunnerError,
    );
    await assert.rejects(
      resolveJailExec({ ...d, config: { ...ON, enabled: false } }, ["--context", "c", "--", "x"]),
      RunnerError,
    );
  });
});

describe("jail exec env file and chdir", () => {
  it("--chdir must be equal to or under a bind, and replaces the first bind-rw default", async () => {
    const d = deps();
    await assert.rejects(
      resolveJailExec(d, ["--context", "c", "--bind-rw", WORK, "--chdir", "/data/payloads/web/other", "--", "sh"]),
      RunnerError,
    );
    const sub = await resolveJailExec(d, ["--context", "c", "--bind-rw", WORK, "--chdir", `${WORK}/sub`, "--", "sh"]);
    assert.equal(sub.argv[sub.argv.indexOf("--chdir") + 1], `${WORK}/sub`);
    const ro = await resolveJailExec(d, [
      "--context",
      "c",
      "--bind-rw",
      WORK,
      "--ro",
      "/data/payloads/web/tools",
      "--chdir",
      "/data/payloads/web/tools",
      "--",
      "sh",
    ]);
    assert.equal(ro.argv[ro.argv.indexOf("--chdir") + 1], "/data/payloads/web/tools");
  });

  it("the env file goes on the --args fd, after the defaults and before the context and the decoy", async () => {
    const ok = await resolveJailExec(deps(), [
      "--context",
      "c",
      "--bind-rw",
      WORK,
      "--env-file",
      `${WORK}/e.env`,
      "--",
      "sh",
    ]);
    assert.equal(ok.envFile, `${WORK}/e.env`);
    assert.equal(ok.argv[ok.argv.indexOf("--args") + 1], "3");
    assert.ok(ok.argv.indexOf("--args") > ok.argv.indexOf("LANG"));
    assert.ok(ok.argv.indexOf("--args") < ok.argv.indexOf("DOZEBOX_CONTEXT"));
    assert.ok(ok.argv.indexOf("--args") < ok.argv.indexOf("AWS_CONFIG_FILE"));
  });

  it("the values never reach the argv", async () => {
    const ok = await resolveJailExec(deps(), [
      "--context",
      "c",
      "--bind-rw",
      WORK,
      "--env-file",
      `${WORK}/e.env`,
      "--",
      "sh",
    ]);
    const content = envArgsContent(parseEnvFile(Buffer.from("HOME=/data/x\0TOKEN=s3cret\0")));
    assert.equal(content, "--setenv\0HOME\0/data/x\0--setenv\0TOKEN\0s3cret\0");
    assert.ok(!ok.argv.join(" ").includes("s3cret"));
    assert.ok(!ok.argv.join(" ").includes("TOKEN"));
  });
});

describe("jail env file", () => {
  it("reads NUL-separated NAME=value records; a value may hold newlines, = and be empty", () => {
    assert.deepEqual(parse("A=1\0B=x=y\nz\0C=\0"), [
      ["A", "1"],
      ["B", "x=y\nz"],
      ["C", ""],
    ]);
    assert.deepEqual(parse(""), []);
    assert.equal(envArgsContent([]), "");
  });

  it("allows HOME but refuses PATH, DOZEBOX_CONTEXT and the AWS file names", () => {
    assert.deepEqual(parse("HOME=/data/payloads/web/home"), [["HOME", "/data/payloads/web/home"]]);
    assert.throws(() => parse("PATH=/evil"), RunnerError);
    assert.throws(() => parse("DOZEBOX_CONTEXT=x"), RunnerError);
    assert.throws(() => parse("AWS_CONFIG_FILE=/home/ubuntu/.aws/config"), RunnerError);
    assert.throws(() => parse("AWS_SHARED_CREDENTIALS_FILE=/home/ubuntu/.aws/credentials"), RunnerError);
  });

  it("refuses a bad name, an empty record and a record without =", () => {
    for (const text of ["1A=x", "A-B=x", "A B=x", "=x", "novalue", "A=1\0\0B=2", "\0", "A=1\0\0"]) {
      assert.throws(() => parse(text), RunnerError, JSON.stringify(text));
    }
  });

  it("refuses more than 512 records and more than 1 MiB", () => {
    const many = Array.from({ length: 513 }, (_, i) => `A${i}=x`).join("\0");
    assert.throws(() => parse(many), RunnerError);
    assert.throws(() => parseEnvFile(Buffer.alloc(ENV_FILE_MAX_BYTES + 1, 0x41)), RunnerError);
  });

  it("never echoes a value in an error", () => {
    let caught: unknown = null;
    try {
      parse("PATH=s3cret");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.ok(!caught.message.includes("s3cret"));
  });
});

describe("jail readiness", () => {
  const signal = new AbortController().signal;

  it("ready when bwrap runs, the profile is there and the table is loaded", async () => {
    const exec = makeFakeExec([{ match: () => true, outcome: { code: 0 } }]);
    const r = await jailReadiness(
      { exec, files: files({ [APPARMOR_PROFILE]: renderAppArmorProfile() }) },
      { ...ON, tripwire: true },
      signal,
    );
    assert.deepEqual(r, { ready: true, egress: "imds-only", missing: [] });
  });

  it("names every missing part", async () => {
    const exec = makeFakeExec([
      { match: ["/usr/bin/bwrap"], outcome: { throws: new Error("ENOENT") } },
      { match: ["nft"], outcome: { code: 1 } },
      { match: ["systemctl"], outcome: { code: 3 } },
    ]);
    const r = await jailReadiness({ exec, files: files({}) }, { ...ON, egress: "allowlist", tripwire: true }, signal);
    assert.deepEqual(r, { ready: false, egress: "allowlist", missing: ["bwrap", "apparmor", "nftables", "tripwire"] });
  });

  it("the profile grants userns to bwrap only", () => {
    const p = renderAppArmorProfile();
    assert.match(p, /^profile dozebox-bwrap \/usr\/bin\/bwrap flags=\(unconfined\) \{$/m);
    assert.match(p, /^ {2}userns,$/m);
  });
});
