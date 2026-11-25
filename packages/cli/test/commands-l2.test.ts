import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { controlStatusFixture, makeFakePrompt } from "@dozebox/testkit/fakes";
import { EXIT } from "../src/command.ts";
import { fakeDeps, mutatingCalls, run } from "./harness.ts";

describe("setup", () => {
  it("first run applies and stores the token; the second run changes nothing", async () => {
    const deps = fakeDeps();
    deps.terraform.changes = true;
    deps.aws.subscriptions.set("arn:aws:sns:us-east-1:111122223333:dozebox-main-alerts", [
      { endpoint: "me@example.com", pending: true },
    ]);
    const first = await run(deps, ["setup"]);
    assert.ok(first.out.some((l) => /Confirm the alert email sent to me@example.com/.test(l)));
    assert.deepEqual(mutatingCalls(deps), ["tf.apply", "aws.putParameter"]);
    const before = mutatingCalls(deps).length;
    await run(deps, ["setup"]);
    assert.equal(mutatingCalls(deps).length, before);
  });

  it("--plan-only applies nothing and stores nothing", async () => {
    const deps = fakeDeps();
    deps.terraform.changes = true;
    assert.equal((await run(deps, ["setup", "--plan-only"])).code, EXIT.ok);
    assert.deepEqual(mutatingCalls(deps), []);
  });
});

describe("secrets", () => {
  it("set reads the value from the prompt (stdin), never from argv", async () => {
    const deps = { ...fakeDeps(), prompt: makeFakePrompt(true, ["https://ntfy.example/s"]) };
    assert.equal((await run(deps, ["secrets", "set", "ntfy-url"])).code, EXIT.ok);
    assert.equal(deps.aws.secretValues.get("ntfy-url"), "https://ntfy.example/s");
    const argv = await run(deps, ["secrets", "set", "ntfy-url", "https://leak.example"]);
    assert.equal(argv.code, EXIT.usage);
    assert.match(argv.err.join(""), /never from arguments/);
    assert.equal(deps.aws.secretValues.get("ntfy-url"), "https://ntfy.example/s");
    assert.equal((await run(deps, ["secrets", "set", "--value", "x", "n"])).code, EXIT.usage);
  });

  it("list prints names only; delete confirms; bad names are usage errors", async () => {
    const deps = fakeDeps();
    deps.aws.secretValues.set("b", "v1");
    deps.aws.secretValues.set("a", "v2");
    const l = await run(deps, ["secrets", "list"]);
    assert.deepEqual(l.out, ["a", "b"]);
    assert.ok(!l.out.join("").includes("v1"));
    assert.equal((await run(deps, ["secrets", "delete", "a", "--yes"])).code, EXIT.ok);
    assert.equal((await run(deps, ["secrets", "delete", "nope", "--yes"])).code, EXIT.usage);
    assert.equal((await run(deps, ["secrets", "set", "../x"])).code, EXIT.usage);
  });
});

describe("token", () => {
  it("show prints the wake link with the token in the fragment; rotate replaces it", async () => {
    const deps = fakeDeps();
    assert.equal((await run(deps, ["token", "show"])).code, EXIT.notSetUp);
    deps.aws.params.set("/dozebox/main/wake-token", { value: "abc", secure: true });
    const s = await run(deps, ["token", "show"]);
    assert.deepEqual(s.out, ["https://d111111abcdef8.cloudfront.net/#t=abc"]);
    const r = await run(deps, ["token", "rotate", "--yes", "--json"]);
    const link = (r.json() as { link: string }).link;
    const token = deps.aws.params.get("/dozebox/main/wake-token")?.value ?? "";
    assert.notEqual(token, "abc");
    assert.equal(link, `https://d111111abcdef8.cloudfront.net/#t=${token}`);
  });
});

describe("phone", () => {
  it("pair stores only a hash; list shows it; revoke deletes it", async () => {
    const deps = fakeDeps();
    deps.aws.params.set("/dozebox/main/wake-token", { value: "wake", secure: true });
    const p = await run(deps, ["phone", "pair", "--label", "pixel", "--json"]);
    assert.equal(p.code, EXIT.ok, p.err.join(" "));
    const { id, link } = p.json() as { id: string; link: string };
    const approve = /&a=([^&]+)&/.exec(link)?.[1] ?? "";
    const stored = deps.aws.params.get(`/dozebox/main/phones/${id}`)?.value ?? "";
    assert.ok(!stored.includes(approve), "the approve token itself is never stored");
    assert.match(stored, /"hash":"[a-f0-9]{64}"/);
    const l = await run(deps, ["phone", "list", "--json"]);
    assert.deepEqual(
      (l.json() as { phones: Array<{ label: string }> }).phones.map((x) => x.label),
      ["pixel"],
    );
    assert.equal((await run(deps, ["phone", "revoke", id, "--yes"])).code, EXIT.ok);
    assert.equal(deps.aws.params.has(`/dozebox/main/phones/${id}`), false);
  });
});

describe("alerts", () => {
  it("test sends the severity; path exits 1 when bad", async () => {
    const deps = fakeDeps({ status: controlStatusFixture({ alertPath: { level: "bad", say: "no sink" } }) });
    await run(deps, ["alerts", "test", "--severity", "page"]);
    assert.deepEqual(deps.control.calls[0], { op: "alertsTest", arg: "page" });
    assert.equal((await run(deps, ["alerts", "test", "--severity", "loud"])).code, EXIT.usage);
    assert.equal((await run(deps, ["alerts", "path"])).code, EXIT.problem);
  });
});

describe("bootstrap", () => {
  it("writes the bootstrap root once, applies, activates the cost tag", async () => {
    const deps = fakeDeps();
    deps.terraform.changes = true;
    deps.aws.facts = { ...deps.aws.facts, costTagActive: false };
    assert.equal((await run(deps, ["bootstrap", "--region", "us-east-1"])).code, EXIT.ok);
    assert.match(deps.fs.files.get("./.dozebox/bootstrap/main.tf") ?? "", /module "bootstrap"/);
    assert.deepEqual(mutatingCalls(deps), ["tf.apply", "aws.activateCostTag"]);
    deps.fs.files.set("./.dozebox/bootstrap/main.tf", "# mine");
    await run(deps, ["bootstrap"]);
    assert.equal(deps.fs.files.get("./.dozebox/bootstrap/main.tf"), "# mine");
  });

  it("--test-account refuses another account before any change", async () => {
    const deps = fakeDeps();
    deps.terraform.changes = true;
    const r = await run(deps, ["bootstrap", "--test-account", "999999999999"]);
    assert.equal(r.code, EXIT.refused);
    assert.equal(deps.terraform.calls.length, 0);
    const ok = await run(deps, ["bootstrap", "--test-account", "111122223333"]);
    assert.equal(ok.code, EXIT.ok);
    assert.deepEqual(deps.terraform.calls.find((c) => c.op === "apply")?.vars, {
      region: "us-east-1",
      tags: '{"dozebox:test":"bootstrap"}',
    });
  });
});
