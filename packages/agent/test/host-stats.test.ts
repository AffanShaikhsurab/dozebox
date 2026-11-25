import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeFakeFs } from "@dozebox/testkit/fakes";
import { makeLinuxHostStats, type HostFs } from "../src/net/hostStats.ts";

const signal = new AbortController().signal;

function fsOf(files: Record<string, string>, dirs: string[] = []): HostFs {
  const fake = makeFakeFs(files);
  for (const d of dirs) fake.vol.mkdirSync(d, { recursive: true });
  const p = fake.fs.promises;
  return {
    statfs: async () => ({ bavail: 25, bsize: 4096, blocks: 100 }),
    readdir: async (path) => (await p.readdir(path)) as string[],
    readFile: async (path) => String(await p.readFile(path, "utf8")),
  };
}

test("space is free and total bytes from statfs", async () => {
  const stats = makeLinuxHostStats({ fs: fsOf({}) });
  assert.deepEqual(await stats.space("/data"), { totalBytes: 409_600, freeBytes: 102_400 });
});

test("txBytes sums every interface except lo and skips a missing file", async () => {
  const base = "/sys/class/net";
  const fs = fsOf(
    {
      [`${base}/lo/statistics/tx_bytes`]: "999\n",
      [`${base}/eth0/statistics/tx_bytes`]: "100\n",
      [`${base}/ens6/statistics/tx_bytes`]: "50\n",
    },
    [`${base}/docker0/statistics`],
  );
  assert.equal(await makeLinuxHostStats({ fs }).txBytes(), 150);
});

test("reach is true on connect, false on error or abort", async () => {
  const calls: string[] = [];
  const stats = makeLinuxHostStats({
    fs: fsOf({}),
    connect: async (host, port) => {
      calls.push(`${host}:${port}`);
      if (host === "bad") throw new Error("refused");
    },
  });
  assert.equal(await stats.reach("good", signal), true);
  assert.equal(await stats.reach("bad", signal), false);
  assert.deepEqual(calls, ["good:443", "bad:443"]);
  const aborted = makeLinuxHostStats({
    fs: fsOf({}),
    connect: (_h, _p, s) => new Promise<void>((_, rej) => s.addEventListener("abort", () => rej(s.reason))),
  });
  const c = new AbortController();
  const r = aborted.reach("x", c.signal);
  c.abort();
  assert.equal(await r, false);
});
