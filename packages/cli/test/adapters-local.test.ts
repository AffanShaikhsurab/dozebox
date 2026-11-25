import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { makeExec } from "../src/adapters/exec.ts";
import { makeCliFiles } from "../src/adapters/files.ts";
import { makePrompt, type PromptInput } from "../src/adapters/prompt.ts";
import { makeTerraform, type TerraformChild } from "../src/adapters/terraform.ts";
import { makeTools } from "../src/adapters/tools.ts";
import { DozeboxCliError } from "../src/command.ts";

type Script = {
  readonly code?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: Error;
  readonly hang?: boolean;
};

function fakeSpawn(script: Script) {
  const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const killed: Array<string | number | undefined> = [];
  const spawn = (command: string, args: ReadonlyArray<string>): TerraformChild => {
    calls.push({ command, args });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (sig?: NodeJS.Signals | number) => {
        killed.push(sig);
        queueMicrotask(() => child.emit("close", null, sig));
        return true;
      },
    });
    queueMicrotask(() => {
      if (script.hang === true) return;
      if (script.error !== undefined) return void child.emit("error", script.error);
      if (script.stdout !== undefined) child.stdout.emit("data", script.stdout);
      if (script.stderr !== undefined) child.stderr.emit("data", script.stderr);
      child.emit("close", script.code ?? 0, null);
    });
    return child as unknown as TerraformChild;
  };
  return { spawn, calls, killed };
}

const never = new AbortController().signal;

describe("terraform adapter", () => {
  it("builds argv for each method", async () => {
    const f = fakeSpawn({ stdout: "{}" });
    const tf = makeTerraform({ spawn: f.spawn, stderr: () => {} });
    await tf.init("d", never);
    await tf.apply("d", { a: "1", b: "x y" }, never);
    await tf.destroy("d", never);
    await tf.output("d");
    assert.deepEqual(
      f.calls.map((c) => [c.command, ...c.args]),
      [
        ["terraform", "-chdir=d", "init", "-input=false"],
        ["terraform", "-chdir=d", "apply", "-input=false", "-auto-approve", "-var", "a=1", "-var", "b=x y"],
        ["terraform", "-chdir=d", "destroy", "-input=false", "-auto-approve"],
        ["terraform", "-chdir=d", "output", "-json"],
      ],
    );
  });

  it("maps the plan exit code: 0 no changes, 2 changes, anything else fails", async () => {
    const plan = (code: number) =>
      makeTerraform({ spawn: fakeSpawn({ code }).spawn, stderr: () => {} }).plan("d", { k: "v" }, never);
    assert.equal(await plan(0), false);
    assert.equal(await plan(2), true);
    await assert.rejects(
      plan(1),
      (e: unknown) => e instanceof DozeboxCliError && e.code === "problem" && /plan failed \(exit 1\)/.test(e.message),
    );
    const f = fakeSpawn({ code: 2 });
    await makeTerraform({ spawn: f.spawn, stderr: () => {} }).plan("d", { k: "v" }, never);
    assert.deepEqual(f.calls[0]?.args, ["-chdir=d", "plan", "-input=false", "-detailed-exitcode", "-var", "k=v"]);
  });

  it("parses output -json and keeps stdout off stderr", async () => {
    const logged: string[] = [];
    const f = fakeSpawn({
      stdout: JSON.stringify({ box_id: { value: "main", sensitive: false }, token: { value: "s", sensitive: true } }),
    });
    const out = await makeTerraform({ spawn: f.spawn, stderr: (c) => void logged.push(c) }).output("d");
    assert.deepEqual(out, { box_id: { value: "main", sensitive: false }, token: { value: "s", sensitive: true } });
    assert.deepEqual(logged, []);
  });

  it("sends terraform's own output to stderr", async () => {
    const logged: string[] = [];
    const f = fakeSpawn({ stdout: "Plan: 1 to add", stderr: "warning" });
    await makeTerraform({ spawn: f.spawn, stderr: (c) => void logged.push(c) }).init("d", never);
    assert.deepEqual(logged, ["Plan: 1 to add", "warning"]);
  });

  it("maps a missing binary to not-set-up and a failed run to a problem", async () => {
    const enoent = Object.assign(new Error("spawn terraform ENOENT"), { code: "ENOENT" });
    const missing = makeTerraform({ spawn: fakeSpawn({ error: enoent }).spawn, stderr: () => {} });
    await assert.rejects(
      missing.init("d", never),
      (e: unknown) => e instanceof DozeboxCliError && e.code === "not-set-up" && /dozebox doctor/.test(e.message),
    );
    const bad = makeTerraform({ spawn: fakeSpawn({ code: 1 }).spawn, stderr: () => {} });
    await assert.rejects(
      bad.apply("d", {}, never),
      (e: unknown) => e instanceof DozeboxCliError && /apply failed \(exit 1\)/.test(e.message),
    );
  });

  it("sends SIGINT to the child on abort", async () => {
    const f = fakeSpawn({ hang: true });
    const c = new AbortController();
    const reason = new Error("stop");
    const run = makeTerraform({ spawn: f.spawn, stderr: () => {} }).apply("d", {}, c.signal);
    c.abort(reason);
    await assert.rejects(run, (e: unknown) => e === reason);
    assert.deepEqual(f.killed, ["SIGINT"]);
  });
});

describe("files adapter", () => {
  it("reads null for a missing file and writes atomically with a private mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dozebox-files-"));
    try {
      const files = makeCliFiles();
      const path = join(dir, "nested", ".dozebox", "stack.json");
      assert.equal(await files.readText(path), null);
      await files.writeText(path, "one");
      await files.writeText(path, "two");
      assert.equal(await files.readText(path), "two");
      assert.deepEqual(await readdir(join(dir, "nested", ".dozebox")), ["stack.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const input = (text: string, isTTY: boolean): PromptInput => {
  const s = Object.assign(new PassThrough(), { isTTY });
  s.end(text);
  return s;
};

describe("prompt adapter", () => {
  it("reads a piped secret and strips one trailing newline", async () => {
    const prompt = makePrompt({ stdin: input("s3cret\n", false), stderr: () => {} });
    assert.equal(await prompt.secret("value"), "s3cret");
    assert.equal(await makePrompt({ stdin: input("a\r\n", false), stderr: () => {} }).secret("v"), "a");
    assert.equal(await makePrompt({ stdin: input("a\n\n", false), stderr: () => {} }).secret("v"), "a\n");
  });

  it("refuses an empty secret", async () => {
    await assert.rejects(
      makePrompt({ stdin: input("\n", false), stderr: () => {} }).secret("v"),
      (e: unknown) => e instanceof DozeboxCliError && e.code === "usage" && e.message === "no value on stdin",
    );
  });

  it("confirms only on a TTY and only for y or yes", async () => {
    const asked: string[] = [];
    assert.equal(await makePrompt({ stdin: input("y\n", false), stderr: () => {} }).confirm("Go?"), false);
    assert.equal(
      await makePrompt({ stdin: input("yes\n", true), stderr: (t) => void asked.push(t) }).confirm("Go?"),
      true,
    );
    assert.deepEqual(asked, ["Go? [y/N] "]);
    assert.equal(await makePrompt({ stdin: input("\n", true), stderr: () => {} }).confirm("Go?"), false);
  });
});

describe("tools adapter", () => {
  it("reads versions and reports a missing tool as null", async () => {
    const tools = makeTools({
      run: async (command) =>
        command === "aws" ? "aws-cli/2.31.0 Python/3.13 Linux/6 exe/x86_64\n" : '{"terraform_version":"1.14.1"}',
      nodeVersion: "24.12.0",
    });
    assert.equal(await tools.version("aws"), "2.31.0");
    assert.equal(await tools.version("terraform"), "1.14.1");
    assert.equal(await tools.version("node"), "24.12.0");
    const none = makeTools({ run: async () => null, nodeVersion: "24.12.0" });
    assert.equal(await none.version("aws"), null);
    assert.equal(await none.version("terraform"), null);
  });
});

describe("exec adapter", () => {
  it("passes output through and reports each line", async () => {
    const f = fakeSpawn({ stdout: "one\ntw", stderr: "err\n", code: 3 });
    const out: string[] = [];
    const lines: string[] = [];
    const exec = makeExec({ spawn: f.spawn, stdout: (c) => void out.push(c), stderr: () => {} });
    const result = await exec.run(["echo", "hi"], { onOutput: (l) => void lines.push(l), signal: never });
    assert.deepEqual(result, { exitCode: 3, signal: null });
    assert.deepEqual(f.calls[0], { command: "echo", args: ["hi"] });
    assert.deepEqual(out, ["one\ntw"]);
    assert.deepEqual(lines, ["one", "err", "tw"]);
  });

  it("sends SIGTERM on abort and answers 127 for a missing command", async () => {
    const f = fakeSpawn({ hang: true });
    const c = new AbortController();
    const pending = makeExec({ spawn: f.spawn, stdout: () => {}, stderr: () => {} }).run(["sleep", "9"], {
      onOutput: () => {},
      signal: c.signal,
    });
    c.abort();
    assert.deepEqual(await pending, { exitCode: 143, signal: "SIGTERM" });
    assert.deepEqual(f.killed, ["SIGTERM"]);

    const enoent = Object.assign(new Error("x"), { code: "ENOENT" });
    const missing = await makeExec({
      spawn: fakeSpawn({ error: enoent }).spawn,
      stdout: () => {},
      stderr: () => {},
    }).run(["nope"], { onOutput: () => {}, signal: never });
    assert.equal(missing.exitCode, 127);
  });
});
