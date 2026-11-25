import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { controlStatusFixture } from "@dozebox/testkit/fakes";
import { EXIT } from "../src/command.ts";
import { fakeDeps, run } from "./harness.ts";

describe("deploy", () => {
  it("applies only when the plan has changes, so deploy twice changes nothing", async () => {
    const deps = fakeDeps();
    deps.terraform.changes = true;
    assert.equal((await run(deps, ["deploy"])).code, EXIT.ok);
    assert.equal((await run(deps, ["deploy"])).code, EXIT.ok);
    assert.deepEqual(
      deps.terraform.calls.map((c) => c.op),
      ["init", "plan", "apply", "output", "init", "plan", "output"],
    );
    assert.ok(deps.fs.files.has("./.dozebox/stack.json"));
  });

  it("--plan-only never applies", async () => {
    const deps = fakeDeps();
    deps.terraform.changes = true;
    await run(deps, ["deploy", "--plan-only", "--stack", "/s"]);
    assert.deepEqual(
      deps.terraform.calls.map((c) => `${c.op} ${c.dir}`),
      ["init /s", "plan /s"],
    );
  });
});

describe("wake", () => {
  it("sends a user wake with a fresh idempotency key", async () => {
    const deps = fakeDeps();
    const r = await run(deps, ["wake"]);
    assert.equal(r.code, EXIT.ok);
    assert.deepEqual(deps.control.calls[0], { op: "wake", arg: { idempotencyKey: "id-1", origin: "user" } });
  });

  it("budget -> 75 with the retry time, frozen -> 5", async () => {
    const deps = fakeDeps();
    deps.control.nextWake = { kind: "budget", retryAfterSeconds: 300 };
    const r = await run(deps, ["wake"]);
    assert.equal(r.code, EXIT.tryLater);
    assert.match(r.err.join(""), /300 s/);
    deps.control.nextWake = { kind: "frozen" };
    assert.equal((await run(deps, ["wake"])).code, EXIT.refused);
  });

  it("--wait waits for serving by default, --until running", async () => {
    const deps = fakeDeps({
      status: controlStatusFixture({ state: "running", servingSince: "2026-11-25T00:01:00.000Z" }),
    });
    assert.equal((await run(deps, ["wake", "--wait"])).code, EXIT.ok);
    await run(deps, ["wake", "--wait", "--until", "running"]);
    assert.deepEqual(
      deps.control.calls.filter((c) => c.op === "waitFor").map((c) => c.arg),
      ["serving", "running"],
    );
  });

  it("--wait past --timeout is a problem (1), a bad --until is usage (2)", async () => {
    const deps = fakeDeps();
    const clock = deps.clock;
    // waitFor that only ends when its signal fires: the deadline from the clock.
    const waitFor = async (_w: string, signal: AbortSignal) => {
      await clock.sleep(10_000_000, signal);
      return controlStatusFixture();
    };
    const d2 = { ...deps, control: { ...deps.control, waitFor } };
    const r = await run(d2, ["wake", "--wait", "--timeout", "60"]);
    assert.equal(r.code, EXIT.problem);
    assert.match(r.err.join(""), /Not serving after 60 s/);
    assert.equal((await run(deps, ["wake", "--until", "soon"])).code, EXIT.usage);
    assert.equal((await run(deps, ["wake", "--timeout", "-3"])).code, EXIT.usage);
  });
});

describe("park and status", () => {
  it("park sends the admin event with force and reason", async () => {
    const deps = fakeDeps();
    await run(deps, ["park", "--force", "--reason", "late"]);
    assert.deepEqual(deps.control.calls, [{ op: "admin", arg: { action: "park", force: true, reason: "late" } }]);
  });

  it("status prints the summary; --records reads records through admin status", async () => {
    const deps = fakeDeps();
    deps.control.onAdmin = () => ({
      records: [
        { key: "rec/liveness", at: "2026-11-24T23:59:00.000Z", writer: "agent" },
        { key: "rec/release", at: "2026-11-24T00:00:00.000Z", writer: "agent" },
      ],
    });
    const r = await run(deps, ["status", "--records"]);
    assert.equal(r.code, EXIT.ok);
    assert.match(r.out[0] ?? "", /^main: parked since 2026-11-25 00:00 UTC/);
    assert.ok(r.out.some((l) => /^rec\/liveness\s+60s\s+agent$/.test(l)));
    const rel = await run(deps, ["status", "--releases", "--json"]);
    assert.deepEqual(
      (rel.json() as { records: Array<{ key: string }> }).records.map((x) => x.key),
      ["rec/release"],
    );
  });
});

describe("upgrade", () => {
  it("records agent_version in the auto tfvars file, keeping other values, then applies", async () => {
    const deps = fakeDeps();
    deps.fs.files.set("./.dozebox/dozebox.auto.tfvars.json", '{"region":"us-east-1"}');
    deps.terraform.changes = true;
    assert.equal((await run(deps, ["upgrade", "--agent", "1.2.3"])).code, EXIT.ok);
    assert.deepEqual(JSON.parse(deps.fs.files.get("./.dozebox/dozebox.auto.tfvars.json") ?? ""), {
      region: "us-east-1",
      agent_version: "1.2.3",
    });
    assert.ok(deps.terraform.calls.some((c) => c.op === "apply"));
    assert.equal((await run(deps, ["upgrade", "--agent", "latest; rm"])).code, EXIT.usage);
    assert.equal((await run(deps, ["upgrade"])).code, EXIT.usage);
  });
});
