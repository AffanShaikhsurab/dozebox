import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { controlStatusFixture, makeFakeCliDeps, stackOutputsFixture } from "@dozebox/testkit/fakes";
import { COMMANDS } from "../src/commands/index.ts";
import { dispatch } from "../src/main.ts";
import { CHUNK_CHARS, deliverAgent, installScript, releaseOf } from "../src/drills/deliver.ts";
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

/** SSM answers: send-command gives an id, every invocation succeeds with `stdout`. */
function ssm(stdout: (script: string) => string) {
  let last = "";
  return (args: ReadonlyArray<string>): unknown => {
    if (args[1] === "send-command") {
      last = (JSON.parse(args[args.indexOf("--parameters") + 1] ?? "{}") as { commands: string[] }).commands[0] ?? "";
      return { Command: { CommandId: "c-1" } };
    }
    if (args[1] === "list-command-invocations") {
      return {
        CommandInvocations: [{ Status: "Success", CommandPlugins: [{ ResponseCode: 0, Output: stdout(last) }] }],
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
    const bytes = new Uint8Array(CHUNK_CHARS); // base64 is 4/3 of it: two chunks
    await deliverAgent(ctx, "i-0123456789abcdef0", new AbortController().signal, async () => bytes);
    const scripts = deps.awsCli.calls
      .filter((c) => c[1] === "send-command")
      .map((c) => (JSON.parse(c[c.indexOf("--parameters") + 1] ?? "{}") as { commands: string[] }).commands[0] ?? "");
    assert.equal(scripts.filter((s) => s.startsWith("printf %s")).length, 2);
    const install = scripts.at(-1) ?? "";
    assert.match(install, /sha256sum --check --status/);
    assert.match(install, /install-agent\.sh "\$v"/);
    assert.equal(ctx.facts.get("delivered"), "0.2.0");
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

  test("a slim release fetches the Node build its NODE file names and checks it", () => {
    const s = installScript("0.2.0", "a".repeat(64));
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
