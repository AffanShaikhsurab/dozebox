import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { extractCommands, runQuickstart, splitArgs } from "../docs/run-quickstart.ts";

const page = (...lines: string[]): string => lines.join("\n");

test("extractCommands takes dozebox commands from bash blocks only, joining continuations", () => {
  const md = page(
    "# Quickstart",
    "```bash",
    "# a comment",
    "dozebox bootstrap --region us-east-1",
    "terraform -chdir=.dozebox init",
    "$ dozebox wake \\",
    "    --wait",
    'printf %s "$VALUE" | dozebox secrets set ntfy-url',
    "```",
    "```text",
    "dozebox not-a-command-here",
    "```",
  );
  assert.deepEqual(extractCommands(md), [
    "dozebox bootstrap --region us-east-1",
    "dozebox wake --wait",
    "dozebox secrets set ntfy-url",
  ]);
});

test("splitArgs groups quoted words and drops a trailing comment", () => {
  assert.deepEqual(splitArgs('dozebox park --reason "long build" # later'), [
    "dozebox",
    "park",
    "--reason",
    "long build",
  ]);
});

test("a quickstart of known commands runs against the fakes", async () => {
  const results = await runQuickstart(page("```bash", "dozebox status", "dozebox wake --wait", "dozebox park", "```"));
  assert.deepEqual(
    results.map((r) => [r.command, r.problem]),
    [
      ["dozebox status", null],
      ["dozebox wake --wait", null],
      ["dozebox park", null],
    ],
  );
});

test("a command the CLI does not know fails the run", async () => {
  const results = await runQuickstart(page("```bash", "dozebox status", "dozebox frobnicate --now", "```"));
  assert.equal(results[0]?.problem, null);
  assert.match(results[1]?.problem ?? "", /unknown command/);
});

test("a flag the CLI does not know fails the run", async () => {
  const results = await runQuickstart(page("```bash", "dozebox status --nope", "```"));
  assert.match(results[0]?.problem ?? "", /exit 2/);
});

test("a page with no dozebox command fails", async () => {
  const results = await runQuickstart(page("```bash", "echo hello", "```"));
  assert.equal(results.length, 1);
  assert.notEqual(results[0]?.problem, null);
});

test("every command in docs/quickstart.md runs", async () => {
  const results = await runQuickstart(readFileSync(join(process.cwd(), "docs", "quickstart.md"), "utf8"));
  assert.deepEqual(
    results.filter((r) => r.problem !== null),
    [],
  );
  assert.ok(results.length >= 6);
});
