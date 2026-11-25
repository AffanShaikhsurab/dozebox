import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { controlStatusFixture, makeFakeCliDeps, stackOutputsFixture } from "@dozebox/testkit/fakes";
import { COMMANDS } from "../src/commands/index.ts";
import { dispatch } from "../src/main.ts";
import { CHUNK_CHARS, IN_FLIGHT, chunkCommand, deliverAgent, installScript, releaseOf } from "../src/drills/deliver.ts";
import { parkByUser } from "../src/drills/flow.ts";
import { smokeDrill } from "../src/drills/smoke.ts";
import type { DrillContext, DrillOptions } from "../src/drills/types.ts";
import { stackFromOutputs } from "../src/stack.ts";

const options = (over: Partial<DrillOptions> = {}): DrillOptions => ({
  withHold: false,
  extras: [],
  keep: false,
  deliver: null,
  broken: null,
  ...over,
});

function context(over: Partial<DrillOptions> = {}) {
  const deps = makeFakeCliDeps({ status: controlStatusFixture(), outputs: stackOutputsFixture() });
  const stack = stackFromOutputs("stack", stackOutputsFixture());
  const lines: string[] = [];
  const ctx: DrillContext = {
    runId: "smoke-1",
    stackDir: "stack",
    nonce: "n-1",
    log: (l) => lines.push(l),
    stack: async () => stack,
    deps,
    options: options(over),
    facts: new Map(),
    cli: async (argv, signal) => {
      const out: string[] = [];
      const code = await dispatch(
        COMMANDS,
        {
          argv: [...argv, "--stack", "stack", "--json", "--yes"],
          stdout: (l) => out.push(l),
          stderr: (l) => out.push(l),
          env: {},
          signal,
          deps,
        },
        "operator",
      );
      return { code, json: code === 0 ? JSON.parse(out.join("\n")) : null, out };
    },
  };
  return { ctx, deps, lines };
}

/** SSM answers: the instance is Online, send-command gives an id per command, every invocation succeeds with `stdout`. */
function ssm(stdout: (script: string) => string) {
  const sent = new Map<string, string>();
  return (args: ReadonlyArray<string>): unknown => {
    if (args[1] === "describe-instance-information") {
      return { InstanceInformationList: [{ PingStatus: "Online" }] };
    }
    if (args[1] === "send-command") {
      const id = `c-${sent.size}`;
      sent.set(
        id,
        (JSON.parse(args[args.indexOf("--parameters") + 1] ?? "{}") as { commands: string[] }).commands[0] ?? "",
      );
      return { Command: { CommandId: id } };
    }
    if (args[1] === "list-command-invocations") {
      const script = sent.get(args[args.indexOf("--command-id") + 1] ?? "") ?? "";
      return {
        CommandInvocations: [{ Status: "Success", CommandPlugins: [{ ResponseCode: 0, Output: stdout(script) }] }],
      };
    }
    return null;
  };
}

describe("deliver", () => {
  test("release name gives version and arch; anything else is a usage error", () => {
    assert.deepEqual(releaseOf("/tmp/dozebox-agent-0.1.0-rc.1-linux-aarch64.tar.gz"), {
      version: "0.1.0-rc.1",
      arch: "aarch64",
    });
    assert.throws(() => releaseOf("/tmp/agent.tgz"), /dozebox-agent/);
  });

  test("pushes the tarball in chunks, checks its sha on the box, then runs install-agent", async () => {
    const { ctx, deps } = context({ deliver: "/r/dozebox-agent-0.2.0-linux-aarch64.tar.gz" });
    deps.awsCli.answer = ssm((s) =>
      s.startsWith("cat /opt/dozebox/current/VERSION") ? "0.1.0\naarch64\n" : "delivered 0.2.0\n",
    );
    const bytes = new Uint8Array((CHUNK_CHARS / 4) * 3 + 1); // base64 is 4/3 of it: two chunks
    await deliverAgent(ctx, "i-0123456789abcdef0", new AbortController().signal, async () => bytes);
    const scripts = deps.awsCli.calls
      .filter((c) => c[1] === "send-command")
      .map((c) => (JSON.parse(c[c.indexOf("--parameters") + 1] ?? "{}") as { commands: string[] }).commands[0] ?? "");
    const parts = scripts.filter((s) => s.startsWith("printf %s"));
    assert.equal(parts.length, 2);
    assert.match(parts[0] ?? "", />\s\/var\/tmp\/dzd\/p0000$/);
    assert.match(parts[1] ?? "", />\s\/var\/tmp\/dzd\/p0001$/);
    const install = scripts.at(-1) ?? "";
    assert.match(install, /sha256sum --check --status/);
    assert.match(install, /install-agent\.sh "\$v"/);
    assert.equal(ctx.facts.get("delivered"), "0.2.0");
  });

  test("a full chunk stays under the 60,000-byte command limit and the parts are sent concurrently", async () => {
    assert.ok(Buffer.byteLength(chunkCommand(9999, "A".repeat(CHUNK_CHARS))) < 60_000);
    assert.equal(CHUNK_CHARS % 4, 0);
    const { ctx, deps } = context({ deliver: "/r/dozebox-agent-0.2.0-linux-aarch64.tar.gz" });
    let open = 0;
    let peak = 0;
    const answer = ssm((s) =>
      s.startsWith("cat /opt/dozebox/current/VERSION") ? "0.1.0\naarch64\n" : "delivered 0.2.0\n",
    );
    deps.awsCli.answer = (args) => {
      if (args[1] === "send-command") peak = Math.max(peak, ++open);
      if (args[1] === "list-command-invocations") open = Math.max(0, open - 1);
      return answer(args);
    };
    const bytes = new Uint8Array((CHUNK_CHARS / 4) * 3 * 6);
    await deliverAgent(ctx, "i-0123456789abcdef0", new AbortController().signal, async () => bytes);
    assert.ok(peak > 1 && peak <= IN_FLIGHT + 1, `peak ${peak}`);
  });

  test("a failed chunk fails the delivery", async () => {
    const { ctx, deps } = context({ deliver: "/r/dozebox-agent-0.2.0-linux-aarch64.tar.gz" });
    const answer = ssm((s) => (s.startsWith("cat /opt/dozebox/current/VERSION") ? "0.1.0\naarch64\n" : ""));
    deps.awsCli.answer = (args) => {
      if (args[1] === "list-command-invocations") {
        const r = answer(args) as { CommandInvocations: [{ Status: string }] };
        return { CommandInvocations: [{ ...r.CommandInvocations[0], Status: "Failed" }] };
      }
      return answer(args);
    };
    await assert.rejects(
      deliverAgent(ctx, "i-0123456789abcdef0", new AbortController().signal, async () => new Uint8Array(10)),
    );
  });

  test("skips a box that already runs the version, refuses a wrong arch", async () => {
    const same = context({ deliver: "/r/dozebox-agent-0.2.0-linux-aarch64.tar.gz" });
    same.deps.awsCli.answer = ssm(() => "0.2.0\naarch64\n");
    await deliverAgent(same.ctx, "i-0123456789abcdef0", new AbortController().signal, async () => {
      throw new Error("must not read");
    });
    const wrong = context({ deliver: "/r/dozebox-agent-0.2.0-linux-x86_64.tar.gz" });
    wrong.deps.awsCli.answer = ssm(() => "0.1.0\naarch64\n");
    await assert.rejects(
      deliverAgent(wrong.ctx, "i-0123456789abcdef0", new AbortController().signal, async () => new Uint8Array(1)),
      /x86_64/,
    );
  });

  test("a slim release reuses an installed Node build of the same version, else fetches and checks it", () => {
    const s = installScript("0.2.0", "a".repeat(64));
    assert.match(s, /\/opt\/dozebox\/releases\/\*\/node\/bin\/node/);
    assert.match(s, /--version[^\n]*= "\$nv"/);
    assert.match(s, /cat "\$d"\/p\[0-9\]\* \| base64 -d/);
    assert.match(s, /read -r nv nsha < "\$rel.new\/NODE"/);
    assert.match(s, /nodejs\.org\/dist\/\$nv/);
  });
});

describe("smoke teardown", () => {
  test("--keep parks a running box and does not destroy", async () => {
    const { ctx, deps } = context({ keep: true });
    deps.control.current = controlStatusFixture({ state: "running", desired: "awake" });
    deps.control.onAdmin = () => {
      deps.control.current = controlStatusFixture();
      return { ok: true };
    };
    await smokeDrill.teardown(ctx);
    assert.ok(deps.control.calls.some((c) => c.op === "admin"));
    assert.equal(deps.terraform.calls.filter((c) => c.op === "destroy").length, 0);
  });

  test("without --keep it destroys the stack", async () => {
    const { ctx, deps } = context();
    await smokeDrill.teardown(ctx);
    assert.equal(deps.terraform.calls.filter((c) => c.op === "destroy").length, 1);
  });
});

describe("park by user", () => {
  test("asks the box itself to sleep and reads the agent's last-words, not the operator park", async () => {
    const { ctx, deps } = context();
    const run = ssm(() => "sleeping\n");
    deps.awsCli.answer = (args) => {
      if (args[1] === "describe-instances") {
        return { Reservations: [{ Instances: [{ InstanceId: "i-0123456789abcdef0", State: { Name: "running" } }] }] };
      }
      if (args[1] === "get-parameter") return { Parameter: { Value: JSON.stringify({ parkedBecause: "user" }) } };
      return run(args);
    };
    const words = await parkByUser(ctx, new AbortController().signal);
    assert.equal(words["parkedBecause"], "user");
    const sent = deps.awsCli.calls.find((c) => c[1] === "send-command");
    assert.match(sent?.[sent.indexOf("--parameters") + 1] ?? "", /--unix-socket \/run\/dozebox\/admin\.sock -X POST .*"reason":"user","force":true.*\/v1\/sleep/);
    assert.equal(deps.control.calls.filter((c) => c.op === "admin").length, 0);
  });
});