import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DiskLevel } from "@dozebox/protocol/v1";
import { makeFakeHostStats } from "@dozebox/testkit/fakes";
import { DISK_DEFAULTS, DISK_LOOP_MS, diskLevel, diskLoop, type DiskReading } from "../src/disk/index.ts";

const space = (freePct: number) => ({ totalBytes: 1000, freeBytes: freePct * 10 });

test("diskLevel table", () => {
  const rows: Array<[number, DiskLevel | undefined, DiskLevel]> = [
    [50, undefined, "ok"],
    [15, undefined, "ok"],
    [14.9, undefined, "low"],
    [5, undefined, "low"],
    [4.9, undefined, "critical"],
    [16, "low", "low"],
    [17.9, "low", "low"],
    [18, "low", "ok"],
    [14, "ok", "low"],
    [7, "critical", "critical"],
    [8, "critical", "low"],
    [17.9, "critical", "low"],
    [18, "critical", "ok"],
    [4, "low", "critical"],
    [6, "ok", "low"],
  ];
  for (const [free, previous, want] of rows) {
    assert.equal(diskLevel(space(free), DISK_DEFAULTS, previous).level, want, `${free}% after ${previous}`);
  }
});

test("diskLevel with no total space is critical at 0%", () => {
  assert.deepEqual(diskLevel({ totalBytes: 0, freeBytes: 0 }), { level: "critical", freePct: 0 });
});

test("diskLoop reports the first reading and each change per path", async () => {
  const stats = makeFakeHostStats();
  const got: DiskReading[] = [];
  const loop = diskLoop({ stats, paths: ["/data", "/"], onChange: (r) => got.push(r) });
  assert.equal(loop.name, "disk");
  assert.equal(loop.everyMs, DISK_LOOP_MS);
  assert.equal(loop.immediate, true);
  const signal = new AbortController().signal;
  stats.spaces.set("/data", space(50));
  stats.spaces.set("/", space(50));
  await loop.tick(signal);
  await loop.tick(signal);
  assert.deepEqual(
    got.map((r) => `${r.path}:${r.level}`),
    ["/data:ok", "/:ok"],
  );
  stats.spaces.set("/data", space(10));
  await loop.tick(signal);
  stats.spaces.set("/data", space(16));
  await loop.tick(signal);
  stats.spaces.set("/data", space(20));
  await loop.tick(signal);
  assert.deepEqual(
    got.slice(2).map((r) => `${r.path}:${r.level}`),
    ["/data:low", "/data:ok"],
  );
});

test("diskLoop uses custom thresholds", async () => {
  const stats = makeFakeHostStats();
  stats.spaces.set("/data", space(30));
  const got: DiskReading[] = [];
  const loop = diskLoop({
    stats,
    paths: ["/data"],
    onChange: (r) => got.push(r),
    thresholds: { lowPct: 40, criticalPct: 20, hysteresisPct: 2 },
  });
  await loop.tick(new AbortController().signal);
  assert.equal(got[0]?.level, "low");
});
