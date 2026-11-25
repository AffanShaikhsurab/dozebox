// adapters/systemd.ts: systemd-notify as a child process, a no-op outside systemd.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeClock, makeFakeExec } from "@dozebox/testkit/fakes";
import { makeSystemdNotify } from "../src/adapters/systemd.ts";

test("sends each state with systemd-notify, with a 5 s timeout", async () => {
  const exec = makeFakeExec([{ match: ["systemd-notify"], outcome: { code: 0 } }]);
  const sd = makeSystemdNotify({ exec, notifySocket: "/run/systemd/notify", timeout: makeFakeClock().timeout });
  await sd.notify("READY=1");
  await sd.notify("STATUS=serving 1 payload");
  assert.deepEqual(
    exec.calls.map((c) => c.argv),
    [
      ["systemd-notify", "READY=1"],
      ["systemd-notify", "STATUS=serving 1 payload"],
    ],
  );
  assert.ok(exec.calls[0]?.opts.signal instanceof AbortSignal);
});

test("without NOTIFY_SOCKET nothing runs", async () => {
  const exec = makeFakeExec([]);
  await makeSystemdNotify({ exec, notifySocket: undefined, timeout: makeFakeClock().timeout }).notify("READY=1");
  assert.equal(exec.calls.length, 0);
});

test("a failing helper is a retryable RunnerError with its stderr", async () => {
  const exec = makeFakeExec([{ match: ["systemd-notify"], outcome: { code: 1, stderr: "No such file\n" } }]);
  const sd = makeSystemdNotify({ exec, notifySocket: "/run/systemd/notify", timeout: makeFakeClock().timeout });
  await assert.rejects(
    sd.notify("WATCHDOG=1"),
    (e) => e instanceof RunnerError && e.retryable && e.message.endsWith("exited 1: No such file"),
  );
});

test("a hung helper is aborted by the timeout", async () => {
  const clock = makeFakeClock();
  const exec = makeFakeExec([{ match: ["systemd-notify"], outcome: { hang: true } }]);
  const p = makeSystemdNotify({ exec, notifySocket: "/run/systemd/notify", timeout: clock.timeout }).notify("READY=1");
  clock.advance(5_000);
  await assert.rejects(p, { name: "TimeoutError" });
});

test("anything but one assignment is refused before a child starts", async () => {
  const exec = makeFakeExec([]);
  const sd = makeSystemdNotify({ exec, notifySocket: "/run/systemd/notify", timeout: makeFakeClock().timeout });
  for (const bad of ["READY", "ready=1", "READY=1\nWATCHDOG=1", "--pid=1"])
    await assert.rejects(sd.notify(bad), /not one sd_notify/);
  assert.equal(exec.calls.length, 0);
});
