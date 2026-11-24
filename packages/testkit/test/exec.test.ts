import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeFakeClock } from "../src/fakes/clock.ts";
import { makeFakeExec, UnscriptedCommandError } from "../src/fakes/exec.ts";

test("FakeExec answers by argv prefix and records every call", async () => {
  const exec = makeFakeExec([
    { match: ["systemctl", "is-active"], outcome: { code: 3, stdout: "inactive\n" } },
    { match: ["systemctl"], outcome: { code: 0 } },
  ]);
  assert.deepEqual(await exec.run(["systemctl", "is-active", "x.service"]), {
    code: 3,
    signal: null,
    stdout: "inactive\n",
    stderr: "",
  });
  assert.equal((await exec.run(["systemctl", "restart", "x.service"])).code, 0);
  assert.equal(exec.of("systemctl").length, 2);
  assert.deepEqual(exec.calls[1]?.argv, ["systemctl", "restart", "x.service"]);
});

test("FakeExec rejects a command no script answers", async () => {
  const exec = makeFakeExec([{ match: ["true"], outcome: {} }]);
  await assert.rejects(exec.run(["rm", "-rf", "/data"]), UnscriptedCommandError);
});

test("FakeExec scripts with `times` are used up, then the next match answers", async () => {
  const exec = makeFakeExec([
    { match: ["mount"], outcome: { code: 32, stderr: "busy" }, times: 1 },
    { match: ["mount"], outcome: { code: 0 } },
  ]);
  assert.equal((await exec.run(["mount", "/dev/x", "/data"])).code, 32);
  assert.equal((await exec.run(["mount", "/dev/x", "/data"])).code, 0);
});

test("FakeExec: a hanging command ends when its signal aborts (driven by the fake clock)", async () => {
  const clock = makeFakeClock(0);
  const exec = makeFakeExec([{ match: ["sleep"], outcome: { hang: true } }]);
  const p = exec.run(["sleep", "infinity"], { signal: clock.timeout(5_000) });
  clock.advance(5_000);
  await assert.rejects(p, (e: unknown) => e instanceof DOMException && e.name === "TimeoutError");
});

test("FakeExec: a script can fail to start or compute its outcome from argv", async () => {
  const exec = makeFakeExec([
    { match: ["missing"], outcome: { throws: Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" }) } },
    { match: (argv) => argv[0] === "echo", outcome: (argv) => ({ stdout: argv.slice(1).join(" ") }) },
  ]);
  await assert.rejects(exec.run(["missing"]), /ENOENT/);
  assert.equal((await exec.run(["echo", "a", "b"])).stdout, "a b");
});
