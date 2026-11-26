// `dozebox-jail-exec` runs through sudo, which drops the caller's environment. It reads the root-owned box.env
// instead; the file must win over anything the payload user put in its own environment.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBoxEnv, readEnv, withBoxEnv } from "../src/env.ts";

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
