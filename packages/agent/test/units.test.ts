// supervisor/units.ts: payload drop-in rendering, golden-tested.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { RESERVED_ENV, type PayloadDefinition } from "@dozebox/protocol/payload";
import { renderUnit, type RenderOptions } from "../src/supervisor/units.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ANALYZE = ["systemd", "analyze"].join("-");
const GOLDEN = join(import.meta.dirname, "golden", "units");
const OPTS: RenderOptions = { socketPath: "/run/dozebox/sock/p.sock", boxId: "box-1", credentials: [], execPrefix: [] };

const marker = JSON.parse(readFileSync(join(ROOT, "examples", "payloads", "marker.json"), "utf8")) as PayloadDefinition;

const full: PayloadDefinition = {
  schema: 1,
  name: "full",
  description: "Uses   every\nfield.",
  user: "svc",
  protocol: "v1",
  install: { command: ["/bin/true"], when: "once", timeoutSeconds: 60 },
  start: {
    command: ["/usr/bin/app", "--title", 'a b "c" 100% $HOME', "plain", ""],
    workingDirectory: "/data/payloads/full/work",
    env: { ZED: "last", ALPHA: "has space", PCT: "50%", MONEY: "$5;now" },
    stopGraceSeconds: 120,
    noNewPrivileges: false,
  },
  limits: { memoryMax: "512M", cpuWeight: 200 },
  secrets: [
    { name: "tls-cert", as: { file: "cert.pem" } },
    { name: "api-token", as: { env: "API_TOKEN" } },
  ],
};
const fullOpts: RenderOptions = {
  ...OPTS,
  credentials: ["cert.pem"],
  execPrefix: ["/usr/bin/dozebox", "jail", "exec", "--"],
};

const minimal: PayloadDefinition = {
  schema: 1,
  name: "mini",
  user: "mini",
  protocol: "v1",
  start: { command: ["/opt/mini/run"] },
};

function golden(file: string, text: string): void {
  const path = join(GOLDEN, file);
  if (process.env["DOZEBOX_UPDATE_GOLDEN"] === "1") {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(path, text);
  }
  assert.equal(text, readFileSync(path, "utf8"));
}

test("golden: examples/payloads/marker.json", () => {
  golden("marker.conf", renderUnit(marker, { ...OPTS, socketPath: "/run/dozebox/sock/marker.sock" }).text);
});

test("golden: a definition using every field", () => {
  golden("full.conf", renderUnit(full, fullOpts).text);
});

test("golden: protocol v1 minimal", () => {
  golden("minimal.conf", renderUnit(minimal, OPTS).text);
});

test("names the unit and the drop-in path", () => {
  const r = renderUnit(minimal, OPTS);
  assert.equal(r.unit, "dozebox-payload@mini.service");
  assert.equal(r.path, "/etc/systemd/system/dozebox-payload@mini.service.d/10-dozebox.conf");
});

test("hash is stable for equal text and changes with the text", () => {
  const a = renderUnit(minimal, OPTS);
  assert.equal(renderUnit(minimal, OPTS).hash, a.hash);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  const b = renderUnit({ ...minimal, start: { command: ["/opt/mini/run", "-v"] } }, OPTS);
  assert.notEqual(b.text, a.text);
  assert.notEqual(b.hash, a.hash);
});

test("a reserved env key is rejected, in start.env and as an env secret", () => {
  for (const key of RESERVED_ENV) {
    const def: PayloadDefinition = { ...minimal, start: { ...minimal.start, env: { [key]: "x" } } };
    const secret: PayloadDefinition = { ...minimal, secrets: [{ name: "tok", as: { env: key } }] };
    for (const d of [def, secret]) {
      assert.throws(
        () => renderUnit(d, OPTS),
        (e) => e instanceof RunnerError && e.code === "invalid_input",
      );
    }
  }
});

test("a newline in an env value is rejected", () => {
  const def: PayloadDefinition = { ...minimal, start: { ...minimal.start, env: { A: "x\nExecStart=/bin/sh" } } };
  assert.throws(
    () => renderUnit(def, OPTS),
    (e) => e instanceof RunnerError && e.code === "invalid_input",
  );
});

test("the six reserved vars are always set, after the definition env", () => {
  const lines = renderUnit(full, fullOpts)
    .text.split("\n")
    .filter((l) => l.startsWith("Environment="));
  const names = lines.map((l) => /^Environment="?([A-Z_0-9]+)=/.exec(l)?.[1]);
  assert.deepEqual(names.slice(-6), [...RESERVED_ENV]);
  assert.deepEqual(names.slice(0, 4), ["ALPHA", "MONEY", "PCT", "ZED"]);
  assert.ok(lines.includes("Environment=DOZEBOX_SOCKET=/run/dozebox/sock/p.sock"));
});

test("EnvironmentFile only with an env secret; limits only when set", () => {
  const mini = renderUnit(minimal, OPTS).text;
  assert.doesNotMatch(mini, /EnvironmentFile=|MemoryMax=|CPUWeight=|LoadCredential=/);
  assert.match(mini, /^TimeoutStopSec=30$/m);
  assert.match(renderUnit(full, fullOpts).text, /^EnvironmentFile=-\/run\/dozebox\/credentials\/full\/env$/m);
});

test("NoNewPrivileges is off only when the definition opts out", () => {
  assert.match(renderUnit(full, fullOpts).text, /^NoNewPrivileges=no$/m);
  assert.doesNotMatch(renderUnit(minimal, OPTS).text, /NoNewPrivileges/);
});

test("systemd-analyze verify accepts the template and a drop-in", (t) => {
  const probe = spawnSync(ANALYZE, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("systemd-analyze not available");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "dozebox-units-"));
  try {
    // Verify the template content as the concrete instance, with its drop-in beside it.
    const unit = "dozebox-payload@full.service";
    cpSync(join(ROOT, "box", "systemd", "dozebox-payload@.service"), join(dir, unit));
    cpSync(join(ROOT, "box", "systemd", "dozebox-payloads.slice"), join(dir, "dozebox-payloads.slice"));
    writeFileSync(join(dir, "dozebox-boot.service"), "[Service]\nType=oneshot\nExecStart=/bin/true\n");
    mkdirSync(join(dir, `${unit}.d`));
    writeFileSync(join(dir, `${unit}.d`, "10-dozebox.conf"), renderUnit(full, fullOpts).text);
    const r = spawnSync(ANALYZE, ["verify", join(dir, unit)], { encoding: "utf8" });
    const tolerated =
      /is not executable|No such file or directory|Failed to (resolve|look up) (user|group)|not found|Unknown user|Unknown group/i;
    const bad = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.includes("dozebox") && !tolerated.test(l));
    assert.deepEqual(bad, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
