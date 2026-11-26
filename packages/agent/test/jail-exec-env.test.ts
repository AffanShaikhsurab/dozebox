// `dozebox-jail-exec` runs through sudo, which drops the caller's environment. It reads the root-owned box.env
// instead; the file must win over anything the payload user put in its own environment, and it is only trusted when
// it is a root-owned regular file no one else can write.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BoxEnvStat, loadBoxEnv, parseBoxEnv, readEnv, withBoxEnv } from "../src/env.ts";

const BOX_ENV = `DOZEBOX_BOX_ID=drill-b8
DOZEBOX_PREFIX=dozebox
DOZEBOX_REGION=us-east-1
DOZEBOX_CONFIG_PARAMETER=/dozebox/drill-b8/config
DOZEBOX_AGENT_VERSION=0.9.0
DOZEBOX_STATE_DIR=/data/dozebox
AWS_REGION=us-east-1
`;

describe("box.env for jail-exec", () => {
  it("reads the DOZEBOX_* keys stage 0 writes and ignores the rest", () => {
    assert.deepEqual(parseBoxEnv(BOX_ENV), {
      DOZEBOX_BOX_ID: "drill-b8",
      DOZEBOX_PREFIX: "dozebox",
      DOZEBOX_REGION: "us-east-1",
      DOZEBOX_CONFIG_PARAMETER: "/dozebox/drill-b8/config",
      DOZEBOX_AGENT_VERSION: "0.9.0",
      DOZEBOX_STATE_DIR: "/data/dozebox",
    });
  });

  it("skips comments, blank lines and malformed lines, and strips quotes", () => {
    assert.deepEqual(parseBoxEnv('# comment\n\nDOZEBOX_BOX_ID="box-1"\nnot a pair\n=empty\nDOZEBOX_STATE_DIR=/x\n'), {
      DOZEBOX_BOX_ID: "box-1",
      DOZEBOX_STATE_DIR: "/x",
    });
  });

  it("the file wins over the caller's env, so a payload user cannot pick another box", () => {
    const caller = {
      DOZEBOX_BOX_ID: "other-box",
      DOZEBOX_STATE_DIR: "/tmp/other",
      DOZEBOX_IMDS_URL: "http://127.0.0.1:9999",
    };
    const env = readEnv(withBoxEnv(caller, parseBoxEnv(BOX_ENV)), 1);
    assert.equal(env.boxId, "drill-b8");
    assert.equal(env.stateDir, "/data/dozebox");
    assert.equal(env.imdsUrl, "http://127.0.0.1:9999", "a key the file does not have still comes from the caller");
  });

  it("without a box.env the caller's env is used, so a manual run still works", () => {
    const env = readEnv(withBoxEnv({ DOZEBOX_BOX_ID: "box-1" }, {}), 1);
    assert.equal(env.boxId, "box-1");
    assert.equal(env.stateDir, "/data/dozebox");
  });
});

const stat = (over: Partial<{ uid: number; mode: number; file: boolean; link: boolean }> = {}): BoxEnvStat => ({
  uid: over.uid ?? 0,
  mode: over.mode ?? 0o644,
  isFile: () => over.file ?? true,
  isSymbolicLink: () => over.link ?? false,
});

const failure = (code: string): Error => Object.assign(new Error(`${code}: box.env`), { code });

/** Injected fs, so the trust check runs unprivileged and without a real /etc/dozebox. */
const deps = (st: BoxEnvStat | Error, text: string | Error = BOX_ENV) => ({
  lstat: async (): Promise<BoxEnvStat> => {
    if (st instanceof Error) throw st;
    return st;
  },
  readFile: async (): Promise<string> => {
    if (text instanceof Error) throw text;
    return text;
  },
});

describe("box.env trust check for jail-exec", () => {
  const sudo = { SUDO_UID: "1000", DOZEBOX_BOX_ID: "other-box", DOZEBOX_STATE_DIR: "/tmp/other" };

  it("trusts a root-owned 0644 regular file", async () => {
    const env = readEnv(await loadBoxEnv(deps(stat()), sudo), 1);
    assert.equal(env.boxId, "drill-b8");
    assert.equal(env.stateDir, "/data/dozebox");
  });

  it("refuses a symlink", async () => {
    await assert.rejects(loadBoxEnv(deps(stat({ file: false, link: true })), sudo), /is not a regular file/);
  });

  it("refuses anything that is not a regular file", async () => {
    await assert.rejects(loadBoxEnv(deps(stat({ file: false })), sudo), /is not a regular file/);
  });

  it("refuses a file owned by another uid", async () => {
    await assert.rejects(loadBoxEnv(deps(stat({ uid: 1000 })), sudo), /owned by uid 1000, not root/);
  });

  it("refuses a group- or world-writable file", async () => {
    await assert.rejects(loadBoxEnv(deps(stat({ mode: 0o664 })), sudo), /group- or world-writable \(mode 664\)/);
    await assert.rejects(loadBoxEnv(deps(stat({ mode: 0o646 })), sudo), /group- or world-writable \(mode 646\)/);
  });

  it("refuses a missing file through sudo instead of falling back to the caller's env", async () => {
    await assert.rejects(
      loadBoxEnv(deps(failure("ENOENT")), sudo),
      /is missing \(ENOENT\); refusing to run through sudo/,
    );
  });

  it("refuses an unreadable file through sudo", async () => {
    await assert.rejects(loadBoxEnv(deps(stat(), failure("EACCES")), sudo), /cannot be read \(EACCES\)/);
  });

  it("a direct root run with no SUDO_UID uses its own env when the file is missing", async () => {
    const env = readEnv(await loadBoxEnv(deps(failure("ENOENT")), { DOZEBOX_BOX_ID: "box-1" }), 1);
    assert.equal(env.boxId, "box-1");
    assert.equal(env.stateDir, "/data/dozebox");
  });

  it("through sudo the caller cannot supply a key the file lacks", async () => {
    const env = readEnv(await loadBoxEnv(deps(stat(), "DOZEBOX_BOX_ID=drill-b8\n"), sudo), 1);
    assert.equal(env.boxId, "drill-b8");
    assert.equal(env.stateDir, "/data/dozebox", "the caller's /tmp/other must not win");
  });

  it("a direct root run still takes a key the file lacks from its own env", async () => {
    const env = readEnv(
      await loadBoxEnv(deps(stat(), "DOZEBOX_BOX_ID=drill-b8\n"), { DOZEBOX_IMDS_URL: "http://127.0.0.1:9999" }),
      1,
    );
    assert.equal(env.imdsUrl, "http://127.0.0.1:9999");
  });
});
