// supervisor/users.ts: `<payload>-agent` gets gid = uid (groupadd first), the first free id from 60000; an existing
// agent user is reused; a payload user is created only when missing.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeFakeExec } from "@dozebox/testkit/fakes";
import { AGENT_UID_MIN, ensureAgentUser, ensureUser } from "../src/supervisor/users.ts";

const PASSWD = [
  "root:x:0:0::/root:/bin/bash",
  "web:x:998:998::/data/home/web:/bin/bash",
  "ci-agent:x:60000:60000::/:/x",
].join("\n");

test("a new agent user: groupadd --gid N, then useradd --uid N --gid N, N the first free id", async () => {
  const exec = makeFakeExec([
    { match: ["getent"], outcome: { code: 2 } },
    { match: () => true, outcome: {} },
  ]);
  const uid = await ensureAgentUser({ exec, passwd: async () => PASSWD }, "web", new AbortController().signal);
  assert.equal(uid, AGENT_UID_MIN + 1);
  assert.deepEqual(
    exec.calls.map((c) => c.argv.join(" ")),
    [
      "getent group 60001",
      "groupadd --system --gid 60001 web-agent",
      "useradd --system --uid 60001 --gid 60001 --no-create-home --shell /usr/sbin/nologin web-agent",
    ],
  );
});

test("an existing agent user is reused; a missing payload user is created", async () => {
  const none = makeFakeExec([]);
  assert.equal(
    await ensureAgentUser({ exec: none, passwd: async () => PASSWD }, "ci", new AbortController().signal),
    60000,
  );
  assert.equal(none.calls.length, 0);
  const exec = makeFakeExec([
    { match: ["id"], outcome: { code: 1 } },
    { match: ["useradd"], outcome: {} },
  ]);
  await ensureUser(exec, "api", new AbortController().signal);
  assert.equal(exec.of("useradd")[0]?.argv.at(-1), "api");
});
