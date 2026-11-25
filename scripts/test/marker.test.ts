// The marker payload (examples/payloads/marker/server.mjs): /health, a nonce written once, and `verify`.
import { strict as assert } from "node:assert";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SERVER = "examples/payloads/marker/server.mjs";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

async function start(env: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env, MARKER_PORT: String(port) } });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("exit", (code) => reject(new Error(`marker exited ${code}`)));
  });
  return { child, port };
}

const stop = (child: ChildProcess): Promise<unknown> => {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  return exited;
};

const verify = (dir: string, nonce: string): number | null =>
  spawnSync(process.execPath, [SERVER, "verify", nonce], { env: { ...process.env, MARKER_DIR: dir } }).status;

test("serves /health, writes the nonce once, and verify compares it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marker-"));
  try {
    const first = await start({ MARKER_DIR: dir, MARKER_NONCE: "abc" });
    const res = await fetch(`http://127.0.0.1:${first.port}/health`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    await stop(first.child);
    assert.equal(readFileSync(join(dir, "nonce"), "utf8").trim(), "abc");

    await stop((await start({ MARKER_DIR: dir, MARKER_NONCE: "other" })).child);
    assert.equal(readFileSync(join(dir, "nonce"), "utf8").trim(), "abc");

    assert.equal(verify(dir, "abc"), 0);
    assert.equal(verify(dir, "other"), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without MARKER_NONCE nothing is written and verify fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marker-"));
  try {
    await stop((await start({ MARKER_DIR: join(dir, "d") })).child);
    assert.equal(verify(join(dir, "d"), "abc"), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
