// box/stage0/*.sh run for real with bash, in a temp dir, with fake curl, systemctl, aws and poweroff on the env overrides.
import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const stage0 = resolve(dirname(fileURLToPath(import.meta.url)), "../../../box/stage0");

function hasBash(): boolean {
  try {
    execFileSync("bash", ["-c", "command -v tar sha256sum timeout curl >/dev/null"]);
    return true;
  } catch {
    return false;
  }
}
const skip =
  process.platform === "win32" || !hasBash() ? "needs Linux with bash, tar, sha256sum, timeout and curl" : false;

type Run = { code: number; stdout: string; stderr: string };
const sh = (path: string, content: string): void => {
  writeFileSync(path, `#!/bin/sh\n${content}`);
  chmodSync(path, 0o755);
};

class Sandbox {
  readonly dir = mkdtempSync(join(tmpdir(), "stage0-"));
  readonly log = join(this.dir, "calls.log");
  readonly values = join(this.dir, "values.log");
  readonly root = join(this.dir, "opt");
  readonly units = join(this.dir, "units");
  readonly run = join(this.dir, "run");
  readonly env: Record<string, string> = {};

  constructor() {
    for (const d of [this.run, this.units]) mkdirSync(d, { recursive: true });
    writeFileSync(this.log, "");
    writeFileSync(this.values, "");
    // Each fake logs `name<TAB>arg<TAB>arg...` so arguments with spaces stay whole.
    const record = `printf '%s' "$(basename "$0")" >> "${this.log}"; for a in "$@"; do printf '\\t%s' "$a" >> "${this.log}"; done; echo >> "${this.log}"`;
    sh(
      join(this.dir, "curl"),
      `${record}\nout=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\n[ -z "$FAKE_CURL_FAIL" ] || exit 22\ncp "$FAKE_TARBALL" "$out"`,
    );
    sh(
      join(this.dir, "systemctl"),
      `${record}\nif [ "$1" = show ]; then\n  case " $FAKE_FAILED " in *" \${5%.service} "*) [ "$3" = ActiveState ] && echo failed || echo exit-code;; *) echo active;; esac\nfi\nexit 0`,
    );
    sh(
      join(this.dir, "aws"),
      `${record}\nfor a in "$@"; do case "$a" in file://*) cat "\${a#file://}" >> "${this.values}";; esac; done\nexit 0`,
    );
    sh(join(this.dir, "poweroff"), record);
    writeFileSync(join(this.dir, "instance-id"), "i-0123456789abcdef0\n");
    writeFileSync(join(this.dir, "boot-id"), "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n");
    writeFileSync(join(this.dir, "uptime"), "4000.12 8000.00\n");
    Object.assign(this.env, {
      DOZEBOX_ROOT: this.root,
      DOZEBOX_UNIT_DIR: this.units,
      DOZEBOX_RUN_DIR: this.run,
      DOZEBOX_ARCH: "aarch64",
      DOZEBOX_SYSTEMCTL_BIN: join(this.dir, "systemctl"),
      DOZEBOX_CURL_BIN: join(this.dir, "curl"),
      DOZEBOX_AWS_BIN: join(this.dir, "aws"),
      DOZEBOX_POWEROFF_COMMAND: join(this.dir, "poweroff"),
      DOZEBOX_INSTANCE_ID_FILE: join(this.dir, "instance-id"),
      DOZEBOX_BOOT_ID_FILE: join(this.dir, "boot-id"),
      DOZEBOX_UPTIME_FILE: join(this.dir, "uptime"),
      DOZEBOX_PREFIX: "dozebox",
      DOZEBOX_BOX_ID: "box-1",
    });
  }

  /** A release tarball with the layout the agent build produces; returns its sha256. */
  tarball(): string {
    const src = join(this.dir, "tarball-src");
    mkdirSync(join(src, "bin"), { recursive: true });
    mkdirSync(join(src, "systemd"), { recursive: true });
    sh(join(src, "bin", "dozeboxd"), "exit 0");
    sh(join(src, "bin", "dozebox-boot"), "exit 0");
    writeFileSync(join(src, "systemd", "dozeboxd.service"), "[Service]\nExecStart=/x\n");
    writeFileSync(join(src, "systemd", "dozebox-boot.service"), "[Service]\nExecStart=/y\n");
    const file = join(this.dir, "agent.tar.gz");
    execFileSync("tar", ["-czf", file, "-C", src, "."]);
    this.env["FAKE_TARBALL"] = file;
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  }

  /** A previously installed release that `current` points to. */
  previousRelease(): string {
    const dir = join(this.root, "releases", "0.9.0");
    mkdirSync(join(dir, "bin"), { recursive: true });
    sh(join(dir, "bin", "dozeboxd"), "exit 0");
    execFileSync("ln", ["-sfn", dir, join(this.root, "current")]);
    return dir;
  }

  exec(script: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
    return new Promise((done) => {
      execFile(
        "bash",
        [join(stage0, script), ...args],
        {
          env: {
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            ...this.env,
            ...(script === "failsafe.sh" ? { DOZEBOX_CURL_BIN: "curl" } : {}),
            ...env,
          },
        },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
          done({ code, stdout, stderr });
        },
      );
    });
  }

  calls(): string[][] {
    return readFileSync(this.log, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => l.split("\t"));
  }
  records(): Record<string, unknown>[] {
    return readFileSync(this.values, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  timeline(): Record<string, unknown>[] {
    return readFileSync(join(this.run, "boot-timeline.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const BASE = "https://artifacts.example/agent";
const names = (sb: Sandbox): string[] => sb.calls().map((c) => c.slice(0, 2).join(" "));

describe("install-agent.sh", { skip }, () => {
  test("a fresh install verifies, switches, installs units and starts them", async () => {
    const sb = new Sandbox();
    try {
      const sha = sb.tarball();
      const r = await sb.exec("install-agent.sh", ["1.0.0", BASE, sha]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(existsSync(join(sb.root, "releases/1.0.0/bin/dozeboxd")));
      assert.equal(readlinkSync(join(sb.root, "current")), join(sb.root, "releases/1.0.0"));
      assert.ok(existsSync(join(sb.units, "dozeboxd.service")));
      assert.ok(existsSync(join(sb.units, "dozebox-boot.service")));
      const calls = sb.calls();
      const curl = calls.filter((c) => c[0] === "curl");
      assert.equal(curl.length, 1);
      assert.ok(curl[0]?.includes(`${BASE}/dozebox-agent-1.0.0-linux-aarch64.tar.gz`));
      assert.deepEqual(
        calls.filter((c) => c[0] === "systemctl"),
        [
          ["systemctl", "daemon-reload"],
          ["systemctl", "enable", "--now", "--no-block", "dozebox-boot.service", "dozeboxd.service"],
        ],
      );
      const [line] = sb.timeline();
      assert.equal(line?.["step"], "agent-install");
      assert.equal(line?.["ok"], true);
      assert.equal(typeof line?.["startedAt"], "number");
      assert.equal(typeof line?.["ms"], "number");
    } finally {
      sb.cleanup();
    }
  });

  test("a second run downloads nothing and still starts the units", async () => {
    const sb = new Sandbox();
    try {
      const sha = sb.tarball();
      assert.equal((await sb.exec("install-agent.sh", ["1.0.0", BASE, sha])).code, 0);
      writeFileSync(sb.log, "");
      const r = await sb.exec("install-agent.sh", ["1.0.0", BASE, sha]);
      assert.equal(r.code, 0, r.stderr);
      const calls = sb.calls();
      assert.equal(calls.filter((c) => c[0] === "curl").length, 0);
      assert.equal(calls.filter((c) => c[0] === "systemctl" && c[1] === "enable").length, 1);
      assert.equal(sb.timeline().length, 2);
    } finally {
      sb.cleanup();
    }
  });

  test("a checksum mismatch keeps the previous release and still starts", async () => {
    const sb = new Sandbox();
    try {
      const previous = sb.previousRelease();
      sb.tarball();
      const r = await sb.exec("install-agent.sh", ["1.0.0", BASE, "0".repeat(64)]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /keeping/);
      assert.equal(readlinkSync(join(sb.root, "current")), previous);
      assert.ok(!existsSync(join(sb.root, "releases/1.0.0")));
      assert.equal(sb.calls().filter((c) => c[0] === "systemctl" && c[1] === "enable").length, 1);
      assert.equal(sb.timeline()[0]?.["ok"], false);
    } finally {
      sb.cleanup();
    }
  });

  test("a download failure with no previous release exits 1 and leaves no symlink", async () => {
    const sb = new Sandbox();
    try {
      const sha = sb.tarball();
      const r = await sb.exec("install-agent.sh", ["1.0.0", BASE, sha], { FAKE_CURL_FAIL: "1" });
      assert.equal(r.code, 1);
      assert.throws(() => lstatSync(join(sb.root, "current")));
      assert.equal(sb.calls().filter((c) => c[0] === "systemctl").length, 0);
      assert.equal(sb.timeline()[0]?.["ok"], false);
    } finally {
      sb.cleanup();
    }
  });

  test("a checksum mismatch with no previous release exits 1", async () => {
    const sb = new Sandbox();
    try {
      sb.tarball();
      const r = await sb.exec("install-agent.sh", ["1.0.0", BASE, "0".repeat(64)]);
      assert.equal(r.code, 1);
      assert.throws(() => lstatSync(join(sb.root, "current")));
      assert.ok(!existsSync(join(sb.root, "releases/1.0.0")));
    } finally {
      sb.cleanup();
    }
  });
});

describe("failsafe.sh", { skip }, () => {
  let imds: Server;
  let imdsUrl = "";
  let groupName: string | null = null;
  before(async () => {
    imds = createServer((req, res) => {
      if (req.method === "PUT" && req.url === "/latest/api/token") {
        res.end("token-123");
      } else if (
        req.headers["x-aws-ec2-metadata-token"] === "token-123" &&
        req.url === "/latest/meta-data/tags/instance/aws:autoscaling:groupName"
      ) {
        if (groupName === null) res.writeHead(404).end();
        else res.end(groupName);
      } else {
        res.writeHead(401).end();
      }
    });
    await new Promise<void>((ok) => imds.listen(0, "127.0.0.1", ok));
    const addr = imds.address();
    imdsUrl = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  });
  after(() => new Promise<void>((ok) => imds.close(() => ok())));

  test("timer mode does nothing once the box served", async () => {
    const sb = new Sandbox();
    try {
      writeFileSync(join(sb.run, "serving"), "");
      const r = await sb.exec("failsafe.sh", [], { DOZEBOX_IMDS_URL: imdsUrl });
      assert.equal(r.code, 0);
      assert.deepEqual(sb.calls(), []);
    } finally {
      sb.cleanup();
    }
  });

  test("group box: writes both records, then sets the group to 0", async () => {
    const sb = new Sandbox();
    groupName = "dozebox-box-1";
    try {
      const r = await sb.exec("failsafe.sh", [], { DOZEBOX_IMDS_URL: imdsUrl });
      assert.equal(r.code, 0, r.stderr);
      const calls = sb.calls();
      assert.deepEqual(
        calls.map((c) => c.slice(0, 2).join(" ")),
        ["aws ssm", "aws ssm", "aws autoscaling"],
      );
      const [put1, put2, scale] = calls;
      assert.deepEqual(put1?.slice(0, 8), [
        "aws",
        "ssm",
        "put-parameter",
        "--name",
        "/dozebox/box-1/rec/last-error",
        "--type",
        "String",
        "--overwrite",
      ]);
      assert.equal(put2?.[4], "/dozebox/box-1/rec/last-words");
      assert.ok(put1?.includes("--cli-read-timeout"));
      assert.deepEqual(scale?.slice(1, 7), [
        "autoscaling",
        "set-desired-capacity",
        "--auto-scaling-group-name",
        "dozebox-box-1",
        "--desired-capacity",
        "0",
      ]);
      assert.ok(scale?.includes("--no-honor-cooldown"));

      const [error, words] = sb.records();
      const writer = { instanceId: "i-0123456789abcdef0", bootId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0" };
      assert.equal(error?.["v"], 1);
      assert.match(String(error?.["at"]), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/);
      assert.deepEqual(error?.["writer"], writer);
      assert.equal(error?.["source"], "failsafe");
      assert.match(String(error?.["message"]), /did not start serving within 66 min/);
      assert.equal(words?.["v"], 1);
      assert.deepEqual(words?.["writer"], writer);
      assert.equal(words?.["parkedBecause"], "failsafe");
      assert.equal(words?.["by"], "failsafe");
      assert.match(String(words?.["detail"]), /did not start serving/);
      assert.deepEqual(words?.["recentErrors"], []);
      assert.equal(words?.["strikes"], 0);
      assert.deepEqual(words?.["awakeBecause"], []);
    } finally {
      sb.cleanup();
    }
  });

  test("persistent box: stops itself", async () => {
    const sb = new Sandbox();
    groupName = null;
    try {
      const r = await sb.exec("failsafe.sh", [], { DOZEBOX_IMDS_URL: imdsUrl });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(names(sb), ["aws ssm", "aws ssm", "aws ec2"]);
      assert.deepEqual(sb.calls()[2]?.slice(1, 5), ["ec2", "stop-instances", "--instance-ids", "i-0123456789abcdef0"]);
    } finally {
      sb.cleanup();
    }
  });

  test("without the AWS CLI it only powers off", async () => {
    const sb = new Sandbox();
    try {
      const r = await sb.exec("failsafe.sh", [], {
        DOZEBOX_IMDS_URL: imdsUrl,
        DOZEBOX_AWS_BIN: join(sb.dir, "missing-aws"),
      });
      assert.equal(r.code, 0);
      assert.deepEqual(sb.calls(), [["poweroff"]]);
    } finally {
      sb.cleanup();
    }
  });

  test("a failed group stop falls back to poweroff", async () => {
    const sb = new Sandbox();
    groupName = "dozebox-box-1";
    try {
      sh(join(sb.dir, "aws"), `printf 'aws\\t%s\\n' "$2" >> "${sb.log}"; [ "$1" = autoscaling ] && exit 1; exit 0`);
      const r = await sb.exec("failsafe.sh", [], { DOZEBOX_IMDS_URL: imdsUrl });
      assert.equal(r.code, 0);
      assert.equal(sb.calls().at(-1)?.[0], "poweroff");
    } finally {
      sb.cleanup();
    }
  });

  test("park-now with no failed unit does nothing", async () => {
    const sb = new Sandbox();
    try {
      const r = await sb.exec("failsafe.sh", [], { DOZEBOX_PARK_NOW: "1", DOZEBOX_IMDS_URL: imdsUrl, FAKE_FAILED: "" });
      assert.equal(r.code, 0);
      assert.ok(sb.calls().every((c) => c[0] === "systemctl"));
    } finally {
      sb.cleanup();
    }
  });

  test("park-now parks when dozeboxd failed, even after the box served", async () => {
    const sb = new Sandbox();
    groupName = "dozebox-box-1";
    try {
      writeFileSync(join(sb.run, "serving"), "");
      const r = await sb.exec("failsafe.sh", [], {
        DOZEBOX_PARK_NOW: "1",
        DOZEBOX_IMDS_URL: imdsUrl,
        FAKE_FAILED: "dozeboxd",
      });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(
        names(sb).filter((n) => n.startsWith("aws")),
        ["aws ssm", "aws ssm", "aws autoscaling"],
      );
      const [error, words] = sb.records();
      assert.match(String(error?.["message"]), /dozeboxd \(exit-code\) failed/);
      assert.equal(words?.["parkedBecause"], "failsafe");
    } finally {
      sb.cleanup();
    }
  });

  test("park-now leaves a sleeping box alone", async () => {
    const sb = new Sandbox();
    try {
      writeFileSync(join(sb.run, "phase"), "sleeping\n");
      const r = await sb.exec("failsafe.sh", [], {
        DOZEBOX_PARK_NOW: "1",
        DOZEBOX_IMDS_URL: imdsUrl,
        FAKE_FAILED: "dozeboxd dozebox-boot",
      });
      assert.equal(r.code, 0);
      assert.deepEqual(sb.calls(), []);
    } finally {
      sb.cleanup();
    }
  });

  test("messages are escaped into valid JSON and capped", async () => {
    const sb = new Sandbox();
    groupName = "g";
    try {
      writeFileSync(join(sb.dir, "result"), `bad "quote" back\\slash\ttab\nline ${"x".repeat(3000)}`);
      sh(
        join(sb.dir, "systemctl"),
        `if [ "$3" = ActiveState ]; then echo failed; else cat "${join(sb.dir, "result")}"; fi`,
      );
      const r = await sb.exec("failsafe.sh", [], { DOZEBOX_PARK_NOW: "1", DOZEBOX_IMDS_URL: imdsUrl });
      assert.equal(r.code, 0, r.stderr);
      const [error, words] = sb.records();
      assert.ok(String(error?.["message"]).length <= 1000);
      assert.match(String(error?.["message"]), /back\\slash\ttab\nline/);
      assert.ok(String(words?.["detail"]).length <= 300);
      assert.match(String(error?.["message"]), /"quote"/);
    } finally {
      sb.cleanup();
    }
  });
});
