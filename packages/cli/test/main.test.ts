import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { DozeboxCliError, EXIT, exitCodeOf, stubCommand, type Command } from "../src/command.ts";
import { COMMANDS } from "../src/commands/index.ts";
import { findCommand, helpText } from "../src/main.ts";
import { fakeDeps, run } from "./harness.ts";

const GOLDEN = new URL("./golden/help.txt", import.meta.url);

describe("helpText", () => {
  it("formats commands and global options", () => {
    const cmds: ReadonlyArray<Command> = [
      stubCommand("T", { name: "go", summary: "Go somewhere.", mode: "operator", mutates: false }),
      stubCommand("T", {
        name: "snapshots list",
        summary: "List snapshots.",
        mode: "operator",
        mutates: false,
        options: { label: { type: "string" }, all: { type: "boolean", short: "a" } },
      }),
    ];
    assert.equal(
      helpText(cmds, "snapshots list"),
      [
        "Usage: dozebox snapshots list [options]",
        "",
        "List snapshots.",
        "",
        "Options:",
        "  --label <value>",
        "  -a, --all",
        "",
        "Global options:",
        "  --box <id>     Which box (default: the stack's box, else main).",
        "  --stack <dir>  Directory with stack.json and the Terraform root (default ./.dozebox).",
        "  --json         One JSON document on stdout; logs on stderr.",
        "  --dry-run      Print every call that would change state, change nothing.",
        "  --yes          Skip confirmation prompts (needed with --json for destructive commands).",
        "  --verbose      Debug logs on stderr.",
        "",
      ].join("\n"),
    );
    assert.match(helpText(cmds), /^Usage: dozebox <command> \[options\]\n\nCommands:\n {2}go {14}Go somewhere\.\n/);
  });

  it("matches the golden operator help", async () => {
    const text = helpText(COMMANDS.filter((c) => c.mode !== "box"));
    if (process.env["UPDATE_GOLDEN"] === "1") await writeFile(GOLDEN, text);
    assert.equal(text, await readFile(GOLDEN, "utf8"));
  });
});

describe("exitCodeOf", () => {
  const table: ReadonlyArray<readonly [string, unknown, number]> = [
    ["usage", new DozeboxCliError("usage", "x"), 2],
    ["not set up", new DozeboxCliError("not-set-up", "x"), 3],
    ["aws", new DozeboxCliError("aws", "x"), 4],
    ["refused", new DozeboxCliError("refused", "x"), 5],
    ["try later", new DozeboxCliError("try-later", "x"), 75],
    ["problem", new DozeboxCliError("problem", "x"), 1],
    ["RunnerError aws_*", Object.assign(new Error("t"), { name: "RunnerError", code: "aws_throttled" }), 4],
    ["RunnerError other", Object.assign(new Error("t"), { name: "RunnerError", code: "internal" }), 1],
    ["abort", new DOMException("aborted", "AbortError"), 130],
    ["plain error", new Error("bug"), 1],
    ["not an error", "string", 1],
  ];
  for (const [name, e, code] of table) it(name, () => assert.equal(exitCodeOf(e), code));
});

describe("dispatch", () => {
  it("picks the longest command name", () => {
    const a = stubCommand("T", { name: "snapshots", summary: "", mode: "operator", mutates: false });
    const b = stubCommand("T", { name: "snapshots list", summary: "", mode: "operator", mutates: false });
    assert.equal(findCommand([a, b], ["snapshots", "list", "--json"])?.command, b);
    assert.deepEqual(findCommand([a, b], ["snapshots", "list", "--json"])?.rest, ["--json"]);
    assert.equal(findCommand([a, b], ["snapshots", "x"])?.command, a);
    assert.equal(findCommand([a, b], ["nope"]), null);
  });

  it("unknown flag is a usage error (strict parsing)", async () => {
    const r = await run(fakeDeps(), ["park", "--nope"]);
    assert.equal(r.code, EXIT.usage);
    assert.match(r.err.join("\n"), /nope/);
  });

  it("unknown command is a usage error; no argv prints help on stderr", async () => {
    assert.equal((await run(fakeDeps(), ["frobnicate"])).code, EXIT.usage);
    const r = await run(fakeDeps(), []);
    assert.equal(r.code, EXIT.usage);
    assert.match(r.err.join("\n"), /^Usage: dozebox/);
  });

  it("help and --help exit 0 on stdout", async () => {
    assert.match((await run(fakeDeps(), ["help", "wake"])).out.join("\n"), /^Usage: dozebox wake/);
    assert.match((await run(fakeDeps(), ["wake", "--help"])).out.join("\n"), /^Usage: dozebox wake/);
    assert.equal((await run(fakeDeps(), ["--help"])).code, EXIT.ok);
  });

  it("--json prints one JSON document, errors included", async () => {
    const ok = await run(fakeDeps(), ["status", "--json"]);
    assert.equal(ok.code, EXIT.ok);
    assert.equal((ok.json() as { box: string }).box, "main");
    const deps = fakeDeps();
    deps.control.nextWake = { kind: "budget", retryAfterSeconds: 120 };
    const bad = await run(deps, ["wake", "--json"]);
    assert.equal(bad.code, EXIT.tryLater);
    assert.deepEqual((bad.json() as { error: { code: string } }).error.code, "try-later");
  });

  it("box mode hides operator commands", async () => {
    const r = await run(fakeDeps(), ["deploy"], { mode: "box" });
    assert.equal(r.code, EXIT.usage);
    assert.match(r.err.join("\n"), /on a box/);
  });

  it("an aborted run exits 130", async () => {
    const c = new AbortController();
    const deps = fakeDeps();
    deps.control.onAdmin = () => {
      c.abort();
      throw new DOMException("aborted", "AbortError");
    };
    assert.equal((await run(deps, ["park"], { signal: c.signal })).code, EXIT.interrupted);
  });
});
