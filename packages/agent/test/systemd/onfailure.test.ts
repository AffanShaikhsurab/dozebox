// systemd behaviour the park-now design relies on (part 6 §6.3, BX2 / notes/c5 D-JG7-1), on the real service
// manager: a unit that keeps crashing hits its start limit, enters `ActiveState=failed`, and its `OnFailure=` unit
// then sees it failed. failsafe.sh parks only in that state (stage0.test.ts covers the script). Needs root and systemd
// as PID 1 (`sudo -E pnpm --filter @dozebox/agent test:systemd` on ubuntu-24.04); skipped elsewhere.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const UNIT_DIR = "/run/systemd/system";
const usable = process.platform === "linux" && process.getuid?.() === 0 && existsSync("/run/systemd/system");

const systemctl = (...args: string[]): string => execFileSync("systemctl", args, { encoding: "utf8" }).trim();

test("a crash loop ends in ActiveState=failed, and OnFailure= sees it failed", { skip: !usable }, async (t) => {
  const id = `dzt-${process.pid}`;
  const crash = `${id}-crash.service`;
  const parkNow = `${id}-park-now.service`;
  const log = join(tmpdir(), `${id}.log`);
  rmSync(log, { force: true });
  writeFileSync(
    join(UNIT_DIR, crash),
    [
      "[Unit]",
      `OnFailure=${parkNow}`,
      "StartLimitIntervalSec=60",
      "StartLimitBurst=3",
      "[Service]",
      "ExecStart=/bin/false",
      "Restart=on-failure",
      "RestartSec=100ms",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(UNIT_DIR, parkNow),
    [
      "[Service]",
      "Type=oneshot",
      `ExecStart=/bin/sh -c 'systemctl show -p ActiveState --value ${crash} >> ${log}'`,
      "",
    ].join("\n"),
  );
  t.after(() => {
    for (const u of [crash, parkNow]) {
      try {
        execFileSync("systemctl", ["stop", u]);
        execFileSync("systemctl", ["reset-failed", u]);
      } catch {
        // already gone
      }
      rmSync(join(UNIT_DIR, u), { force: true });
    }
    execFileSync("systemctl", ["daemon-reload"]);
    rmSync(log, { force: true });
  });
  systemctl("daemon-reload");
  systemctl("start", "--no-block", crash);

  // The start limit is hit after 3 starts 100 ms apart; wait for the manager, not for a fixed time.
  for (let i = 0; i < 300 && systemctl("show", "-p", "ActiveState", "--value", crash) !== "failed"; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(systemctl("show", "-p", "ActiveState", "--value", crash), "failed");
  const result = systemctl("show", "-p", "Result", "--value", crash);
  for (let i = 0; i < 100 && !readFileSync(log, { flag: "a+", encoding: "utf8" }).includes("failed"); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const seen = readFileSync(log, "utf8").trim().split("\n");
  // Earlier lines (if this systemd fires OnFailure= before an automatic restart) show a state that is not failed.
  assert.equal(seen.at(-1), "failed");
  t.diagnostic(`OnFailure= ran ${seen.length} time(s): ${seen.join(", ")}`);
});
