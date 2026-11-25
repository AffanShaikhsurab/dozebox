import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { controlStatusFixture, stackOutputsFixture } from "@dozebox/testkit/fakes";
import { DozeboxCliError, EXIT } from "../src/command.ts";
import { doctorChecks, type DoctorInput } from "../src/doctor/checks.ts";
import { stackFromOutputs } from "../src/stack.ts";
import { fakeDeps, run } from "./harness.ts";

const stack = stackFromOutputs("./.dozebox", stackOutputsFixture({ iam_policy_sizes: { control: 4000 } }));
const NOW = Date.parse("2026-11-25T00:00:00.000Z");

const healthy: DoctorInput = {
  tools: { aws: "2.31.0", terraform: "1.14.1", node: "24.12.0" },
  facts: {
    account: "111122223333",
    region: "us-east-1",
    costTagActive: true,
    unreservedConcurrency: 1000,
    spotVcpuQuota: 32,
    onDemandVcpuQuota: 32,
  },
  stack: { ...stack, frontDoorDomain: "d111111abcdef8.cloudfront.net" },
  missingOutputs: [],
  now: NOW,
  status: controlStatusFixture({ restoreTest: { result: "ok", at: "2026-11-23T04:00:00.000Z" } }),
  statusError: null,
  tokenPresent: true,
  emailSubscriptions: [{ endpoint: "me@example.com", pending: false }],
};

const levels = (i: DoctorInput): Record<string, string> =>
  Object.fromEntries(doctorChecks().map((c) => [c.id, c.run(i).level]));

describe("doctor checks", () => {
  it("all ok on a healthy box", () => {
    assert.deepEqual(
      Object.entries(levels(healthy)).filter(([, l]) => l !== "ok"),
      [],
    );
  });

  const table: ReadonlyArray<readonly [string, Partial<DoctorInput>, string, "warn" | "fail"]> = [
    ["no terraform", { tools: { ...healthy.tools, terraform: null } }, "tool-terraform", "fail"],
    ["no aws cli", { tools: { ...healthy.tools, aws: null } }, "tool-aws", "warn"],
    ["no credentials", { facts: { ...healthy.facts, account: null } }, "credentials", "fail"],
    ["no region", { facts: { ...healthy.facts, region: null } }, "region", "fail"],
    ["region differs", { facts: { ...healthy.facts, region: "eu-west-1" } }, "region", "warn"],
    ["cost tag inactive", { facts: { ...healthy.facts, costTagActive: false } }, "cost-tag", "warn"],
    ["cost tag unknown", { facts: { ...healthy.facts, costTagActive: null } }, "cost-tag", "warn"],
    ["low concurrency", { facts: { ...healthy.facts, unreservedConcurrency: 9 } }, "lambda-concurrency", "fail"],
    ["spot quota 0", { facts: { ...healthy.facts, spotVcpuQuota: 0 } }, "quota-spot", "warn"],
    ["missing output", { stack: null, missingOutputs: ["control_url"] }, "stack-outputs", "fail"],
    ["no stack", { stack: null }, "stack-outputs", "fail"],
    ["policy too big", { stack: { ...stack, policySizes: { control: 7000 } } }, "policy-sizes", "fail"],
    ["control down", { status: null, statusError: "ECONNREFUSED" }, "control", "fail"],
    ["no token", { tokenPresent: false }, "token", "fail"],
    ["frozen", { status: controlStatusFixture({ frozen: true }) }, "frozen", "fail"],
    ["alert path bad", { status: controlStatusFixture({ alertPath: { level: "bad" } }) }, "alert-path", "fail"],
    ["email pending", { emailSubscriptions: [{ endpoint: "a@b.c", pending: true }] }, "alert-email", "warn"],
    ["no front door", { stack }, "front-door", "warn"],
    ["restore never ran", { status: controlStatusFixture() }, "restore-test", "warn"],
    [
      "restore failed",
      { status: controlStatusFixture({ restoreTest: { result: "failed", at: "2026-11-24T04:00:00.000Z" } }) },
      "restore-test",
      "fail",
    ],
    [
      "restore stale",
      { status: controlStatusFixture({ restoreTest: { result: "ok", at: "2026-11-10T04:00:00.000Z" } }) },
      "restore-test",
      "warn",
    ],
  ];
  for (const [name, over, id, level] of table) {
    it(name, () => assert.equal(levels({ ...healthy, ...over })[id], level));
  }
});

describe("doctor command", () => {
  it("exits 1 on a failing check; --fix stores a missing token and passes", async () => {
    const deps = fakeDeps();
    const r = await run(deps, ["doctor"]);
    assert.equal(r.code, EXIT.problem);
    assert.ok(r.out.some((l) => /^FAIL {2}token/.test(l)));
    const fixed = await run(deps, ["doctor", "--fix", "--json"]);
    assert.equal(fixed.code, EXIT.ok);
    assert.deepEqual((fixed.json() as { fixed: string[] }).fixed, ["token"]);
    const token = deps.aws.params.get("/dozebox/main/wake-token");
    assert.equal(token?.secure, true);
    assert.equal(token?.value.length, 43);
  });

  it("a missing stack is a failing check, not a crash", async () => {
    const deps = fakeDeps();
    deps.terraform.outputs = {};
    const r = await run(deps, ["doctor"]);
    assert.equal(r.code, EXIT.problem);
    assert.ok(r.out.some((l) => /stack-outputs\s+missing outputs: box_id/.test(l)));
  });
});

async function failingOutput(): Promise<never> {
  throw new DozeboxCliError("problem", "terraform output failed (exit 1)");
}

describe("readStack", () => {
  it("names every missing output and exits 3", async () => {
    const deps = fakeDeps();
    deps.terraform.outputs = stackOutputsFixture({ control_url: undefined, region: "" });
    const s = await run(deps, ["deploy"]);

    assert.equal(s.code, EXIT.notSetUp);
    assert.match(s.err.join(""), /no region, control_url output/);
  });

  it("a stack dir terraform cannot read (no stack yet) is exit 3", async () => {
    const deps = fakeDeps();
    const r = await run({ ...deps, terraform: { ...deps.terraform, output: failingOutput } }, ["snapshots", "list"]);
    assert.equal(r.code, EXIT.notSetUp);
  });

  it("caches non-sensitive outputs only and reads the cache next time", async () => {
    const deps = fakeDeps();
    deps.terraform.outputs = { ...stackOutputsFixture(), secret: { value: "s3cr3t", sensitive: true } };
    await run(deps, ["deploy"]);
    const cached = deps.fs.files.get("./.dozebox/stack.json") ?? "";
    assert.doesNotMatch(cached, /s3cr3t/);
    assert.equal(deps.terraform.calls.filter((c) => c.op === "output").length, 1);
    await run(deps, ["doctor"]);
    assert.equal(deps.terraform.calls.filter((c) => c.op === "output").length, 1);
  });

  it("--box that does not match the stack is a usage error", async () => {
    const d = await run(fakeDeps(), ["deploy", "--box", "other"]);
    assert.equal(d.code, EXIT.usage);
  });
});
