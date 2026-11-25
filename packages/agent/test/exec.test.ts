// adapters/exec.ts with real child processes (node itself, so the test runs anywhere Node does).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeNodeExec } from "../src/adapters/exec.ts";

const node = process.execPath;

test("collects stdout, stderr and the exit code; feeds input", async () => {
  const r = await makeNodeExec().run(
    [
      node,
      "-e",
      "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase())); process.stderr.write('e'); process.on('exit', () => process.exitCode = 3)",
    ],
    { input: "abc" },
  );
  assert.deepEqual(r, { code: 3, signal: null, stdout: "ABC", stderr: "e" });
});

test("a missing program rejects; an empty argv rejects", async () => {
  await assert.rejects(makeNodeExec().run(["/nonexistent/dozebox-test-binary"]), { code: "ENOENT" });
  await assert.rejects(makeNodeExec().run([]), /needs a command/);
});

test("an abort kills the child and rejects", async () => {
  const ctl = new AbortController();
  const p = makeNodeExec().run([node, "-e", "setTimeout(() => {}, 60000)"], { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 50);
  await assert.rejects(p, { name: "AbortError" });
});
