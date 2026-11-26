// box/: the user-data copies equal their files, box.env renders, and every unit has the directives the design needs.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const box = resolve(dirname(fileURLToPath(import.meta.url)), "../../../box");
const read = (rel: string): string => readFileSync(join(box, rel), "utf8");
const template = read("cloud-init.yaml.tftpl");
const analyze = process.env["SYSTEMD_ANALYZE_BIN"] ?? "systemd-analyze";

/** The content block of one write_files entry, un-indented and un-escaped. */
function inlined(path: string): string {
  const lines = template.split("\n");
  const start = lines.indexOf(`  - path: ${path}`);
  assert.ok(start >= 0, `${path} is in the template`);
  const at = lines.indexOf("    content: |", start);
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line !== "" && !line.startsWith("      ")) break;
    out.push(line.slice(6));
  }
  return out
    .join("\n")
    .replace(/\$\$\{/g, "${")
    .replace(/%%\{/g, "%{");
}

type Unit = Map<string, Map<string, string[]>>;
function parseUnit(text: string): Unit {
  const unit: Unit = new Map();
  let section: Map<string, string[]> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      section = new Map();
      unit.set(header[1], section);
      continue;
    }
    const kv = /^(\w+)=(.*)$/.exec(line);
    assert.ok(section !== undefined && kv?.[1] !== undefined, `not INI: ${line}`);
    section.set(kv[1], [...(section.get(kv[1]) ?? []), kv[2] ?? ""]);
  }
  return unit;
}
const unit = (name: string): Unit => parseUnit(read(`systemd/${name}`));
const get = (u: Unit, section: string, key: string): string | undefined => u.get(section)?.get(key)?.[0];

describe("cloud-init.yaml.tftpl", () => {
  test("the inlined scripts and units equal the files in box/", () => {
    for (const [path, file] of [
      ["/opt/dozebox/stage0/install-agent.sh", "stage0/install-agent.sh"],
      ["/opt/dozebox/stage0/stage0.sh", "stage0/stage0.sh"],
      ["/opt/dozebox/stage0/failsafe.sh", "stage0/failsafe.sh"],
      ["/etc/systemd/system/dozebox-stage0.service", "systemd/dozebox-stage0.service"],
      ["/etc/systemd/system/dozebox-failsafe.service", "systemd/dozebox-failsafe.service"],
      ["/etc/systemd/system/dozebox-failsafe.timer", "systemd/dozebox-failsafe.timer"],
      ["/etc/systemd/system/dozebox-park-now.service", "systemd/dozebox-park-now.service"],
    ] as const) {
      assert.equal(inlined(path), read(file).replace(/\n$/, ""), path);
    }
  });

  test("box.env has the design's keys, from the template variables", () => {
    const pairs = Object.fromEntries(
      inlined("/etc/dozebox/box.env")
        .split("\n")
        .map((l) => l.split("=") as [string, string]),
    );
    assert.deepEqual(pairs, {
      DOZEBOX_BOX_ID: "${box_id}",
      DOZEBOX_PREFIX: "${name_prefix}",
      DOZEBOX_REGION: "${region}",
      DOZEBOX_CONFIG_PARAMETER: "${config_parameter}",
      DOZEBOX_AGENT_VERSION: "${agent_version}",
      DOZEBOX_AGENT_BASE_URL: "${agent_base_url}",
      DOZEBOX_AGENT_SHA256: "${agent_sha256}",
      DOZEBOX_STATE_DIR: "/data/dozebox",
      AWS_REGION: "${region}",
      AWS_DEFAULT_REGION: "${region}",
    });
  });

  test("stage 0 is a unit enabled on every boot, not a once-per-instance runcmd", () => {
    assert.equal(inlined("/etc/tmpfiles.d/dozebox.conf"), "d /run/dozebox 0755 root root -");
    const bootcmd = template.slice(template.indexOf("\nbootcmd:"), template.indexOf("\nruncmd:"));
    assert.match(bootcmd, /systemctl enable --now --no-block dozebox-stage0\.service/);
    const runcmd = template.slice(template.indexOf("\nruncmd:"));
    assert.match(runcmd, /systemctl enable --now dozebox-stage0\.service/);
    assert.doesNotMatch(runcmd, /install-agent\.sh/, "runcmd runs once per instance; stage 0 must not live there");
    assert.match(
      inlined("/etc/systemd/system/dozebox-stage0.service"),
      /^ExecStart=\/opt\/dozebox\/stage0\/stage0\.sh /m,
    );
  });

  test("only the design's template variables appear, and no unescaped shell expansion", () => {
    const vars = new Set([
      "box_id",
      "name_prefix",
      "region",
      "config_parameter",
      "agent_version",
      "agent_base_url",
      "agent_sha256",
    ]);
    for (const m of template.matchAll(/(?<!\$)\$\{(\w+)\}/g))
      assert.ok(vars.has(m[1] ?? ""), `unknown variable ${m[1]}`);
    assert.doesNotMatch(
      template,
      /(?<!\$)\$\{[^}]*[^\w}][^}]*\}/,
      "an unescaped shell expansion would break templatefile",
    );
    assert.doesNotMatch(template, /(?<!%)%\{/);
  });
});

describe("box/systemd units", () => {
  test("dozebox-boot.service", () => {
    const u = unit("dozebox-boot.service");
    assert.equal(get(u, "Service", "Type"), "oneshot");
    assert.equal(get(u, "Service", "RemainAfterExit"), "yes");
    assert.equal(get(u, "Unit", "After"), "network-online.target");
    assert.equal(get(u, "Unit", "Wants"), "network-online.target");
    assert.equal(get(u, "Service", "EnvironmentFile"), "/etc/dozebox/box.env");
    assert.equal(get(u, "Service", "ExecStart"), "/opt/dozebox/current/bin/dozebox-boot");
    assert.equal(get(u, "Service", "TimeoutStartSec"), "10min");
    assert.equal(get(u, "Unit", "OnFailure"), "dozebox-park-now.service");
    assert.equal(get(u, "Install", "WantedBy"), "multi-user.target");
  });

  test("dozebox-payload@.service keeps the hardened default", () => {
    const u = unit("dozebox-payload@.service");
    assert.equal(get(u, "Service", "NoNewPrivileges"), "yes");
    assert.equal(get(u, "Service", "PrivateTmp"), "yes");
    assert.equal(get(u, "Service", "ProtectSystem"), "full");
  });

  test("dozeboxd.service", () => {
    const u = unit("dozeboxd.service");
    const expected: [string, string, string][] = [
      ["Service", "Type", "notify"],
      ["Service", "NotifyAccess", "all"],
      ["Service", "WatchdogSec", "60"],
      ["Unit", "Requires", "dozebox-boot.service"],
      ["Unit", "After", "dozebox-boot.service network-online.target"],
      ["Unit", "Wants", "network-online.target"],
      ["Service", "EnvironmentFile", "/etc/dozebox/box.env"],
      ["Service", "ExecStart", "/opt/dozebox/current/bin/dozeboxd"],
      ["Service", "Restart", "on-failure"],
      ["Service", "RestartSec", "5"],
      ["Unit", "StartLimitBurst", "5"],
      ["Unit", "StartLimitIntervalSec", "600"],
      ["Unit", "OnFailure", "dozebox-park-now.service"],
      ["Service", "RuntimeDirectory", "dozebox"],
      ["Service", "RuntimeDirectoryPreserve", "yes"],
      ["Service", "TimeoutStartSec", "180"],
      ["Service", "TimeoutStopSec", "90"],
      ["Service", "KillMode", "mixed"],
      ["Install", "WantedBy", "multi-user.target"],
    ];
    for (const [section, key, value] of expected) assert.equal(get(u, section, key), value, `${section}.${key}`);
  });

  test("the failsafe and park-now units run failsafe.sh", () => {
    for (const name of ["dozebox-failsafe.service", "dozebox-park-now.service"]) {
      const u = unit(name);
      assert.equal(get(u, "Service", "Type"), "oneshot");
      assert.equal(get(u, "Service", "EnvironmentFile"), "/etc/dozebox/box.env");
      assert.equal(get(u, "Service", "ExecStart"), "/opt/dozebox/stage0/failsafe.sh");
      assert.equal(get(u, "Service", "TimeoutStartSec"), "5min");
    }
    assert.equal(get(unit("dozebox-park-now.service"), "Service", "Environment"), "DOZEBOX_PARK_NOW=1");
    assert.equal(get(unit("dozebox-failsafe.service"), "Service", "Environment"), undefined);
  });

  test("dozebox-failsafe.timer", () => {
    const u = unit("dozebox-failsafe.timer");
    assert.equal(get(u, "Timer", "OnBootSec"), "60min");
    assert.equal(get(u, "Timer", "OnUnitActiveSec"), "15min");
    assert.equal(get(u, "Install", "WantedBy"), "timers.target");
  });

  test("dozebox-stage0.service runs stage 0 on every boot", () => {
    const u = unit("dozebox-stage0.service");
    assert.equal(get(u, "Service", "Type"), "oneshot");
    assert.equal(get(u, "Service", "RemainAfterExit"), "yes");
    assert.equal(get(u, "Service", "EnvironmentFile"), "/etc/dozebox/box.env");
    assert.equal(
      get(u, "Service", "ExecStart"),
      "/opt/dozebox/stage0/stage0.sh ${DOZEBOX_AGENT_VERSION} ${DOZEBOX_AGENT_BASE_URL} ${DOZEBOX_AGENT_SHA256}",
    );
    assert.equal(get(u, "Unit", "Before"), "dozebox-boot.service");
    assert.equal(get(u, "Install", "WantedBy"), "multi-user.target");
  });

  const hasAnalyze = spawnSync(analyze, ["--version"]).status === 0;
  test(
    "systemd-analyze verify accepts the units",
    { skip: hasAnalyze ? false : "systemd-analyze is not installed" },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "units-"));
      try {
        const files = readdirSync(join(box, "systemd")).filter((f) =>
          /^dozebox(d|-boot|-park-now|-failsafe|-stage0)\.?.*\.(service|timer)$/.test(f),
        );
        for (const f of files) copyFileSync(join(box, "systemd", f), join(dir, f));
        const r = spawnSync(analyze, ["verify", ...files.map((f) => join(dir, f))], { encoding: "utf8" });
        // Missing executables (the release is not installed here) and unavailable system units are expected.
        const problems = r.stderr
          .split("\n")
          .filter((l) => l.trim() !== "")
          .filter(
            (l) =>
              !/Command .* is not executable|No such file or directory|Failed to prepare filename|network-online\.target/.test(
                l,
              ),
          );
        assert.deepEqual(problems, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
