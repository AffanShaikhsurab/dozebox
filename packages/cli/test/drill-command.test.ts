import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { controlStatusFixture, makeFakeCliDeps, stackOutputsFixture, type FakeCliDeps } from "@dozebox/testkit/fakes";
import { EXIT } from "../src/command.ts";
import { drillCommand } from "../src/commands/drill.ts";
import { COMMANDS } from "../src/commands/index.ts";
import type { Drill } from "../src/drills/types.ts";
import { dispatch } from "../src/main.ts";

const probe: Drill = {
  name: "probe",
  estimateUsd: async () => 0.1,
  steps: [
    {
      id: "status",
      deadlineMs: 10_000,
      run: async (ctx, signal) => {
        const r = await ctx.cli(["status"], signal);
        ctx.facts.set("code", r.code);
        ctx.facts.set("json", r.json);
        ctx.facts.set("nonce", ctx.nonce);
        ctx.facts.set("options", ctx.options);
      },
    },
  ],
  teardown: async () => {},
};

const commands = (): typeof COMMANDS => COMMANDS;

async function drill(deps: FakeCliDeps, argv: ReadonlyArray<string>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await dispatch(
    [drillCommand(commands, [probe]), ...COMMANDS],
    {
      argv,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      env: {},
      signal: new AbortController().signal,
      deps,
    },
    "operator",
  );
  return { code, out, err };
}

const fresh = (outputs = stackOutputsFixture()): FakeCliDeps =>
  makeFakeCliDeps({ status: controlStatusFixture(), outputs });

describe("dozebox drill", () => {
  it("an unknown drill is a usage error that lists the names", async () => {
    const r = await drill(fresh(), ["drill", "nope"]);
    assert.equal(r.code, EXIT.usage);
    assert.match(r.err.join("\n"), /unknown drill: nope.*probe/);
  });

  it("refuses --dry-run: drills act on real AWS", async () => {
    const deps = fresh();
    const r = await drill(deps, ["drill", "probe", "--dry-run"]);
    assert.equal(r.code, EXIT.usage);
    assert.equal(deps.fs.files.size, 0);
  });

  it("runs the drill, passes --stack/--json/--yes to its commands, writes the report", async () => {
    const deps = fresh(stackOutputsFixture({ marker_nonce: "abc123" }));
    const r = await drill(deps, [
      "drill",
      "probe",
      "--stack",
      "/s",
      "--report",
      "out/r.json",
      "--keep",
      "--extra",
      "jail, tripwire",
      "--json",
    ]);
    assert.equal(r.code, EXIT.ok, r.err.join("\n"));
    const text = deps.fs.files.get("out/r.json") ?? "";
    assert.ok(text.endsWith("}\n"));
    const report = JSON.parse(text);
    assert.equal(report.ok, true);
    assert.equal(report.runId, "probe-20261125000000");
    assert.equal(report.facts.code, 0);
    assert.equal(report.facts.nonce, "abc123");
    assert.equal(report.facts.json.box, "main");
    assert.equal(report.options.keep, true);
    assert.deepEqual(report.options.extras, ["jail", "tripwire"]);
    assert.deepEqual(JSON.parse(r.out.join("\n")), report);
    assert.ok(deps.terraform.calls.every((c) => c.dir === "/s"));
    assert.ok(r.err.some((l) => l.startsWith("[drill probe-20261125000000] step status ok")));
  });

  it("--nonce wins; with no output nonce a random one is used; the default report path is drills/<runId>.json", async () => {
    const given = await drill(fresh(stackOutputsFixture({ marker_nonce: "abc" })), [
      "drill",
      "probe",
      "--nonce",
      "mine",
      "--json",
    ]);
    assert.equal(JSON.parse(given.out.join("\n")).facts.nonce, "mine");
    const deps = fresh();
    const r = await drill(deps, ["drill", "probe", "--json"]);
    assert.equal(JSON.parse(r.out.join("\n")).facts.nonce, "id-1");
    assert.ok(deps.fs.files.has("drills/probe-20261125000000.json"));
  });

  it("without --json prints a one-line summary; a refused drill exits 5 and still writes the report", async () => {
    const deps = fresh();
    const ok = await drill(deps, ["drill", "probe"]);
    assert.equal(ok.code, EXIT.ok);
    assert.equal(ok.out.length, 1);
    assert.match(ok.out[0] ?? "", /^drill probe ok: 1 steps/);
    deps.aws.spendUsd = 9;
    const refused = await drill(deps, ["drill", "probe", "--test-budget", "10"]);
    assert.equal(refused.code, EXIT.refused);
    assert.match(refused.out[0] ?? "", /refused/);
  });

  it("a bad --test-budget is a usage error", async () => {
    assert.equal((await drill(fresh(), ["drill", "probe", "--test-budget", "0"])).code, EXIT.usage);
  });
});
