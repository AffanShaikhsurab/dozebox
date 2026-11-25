// boot/: the attach tag fence (never force-detach), the mkfs guard, the timeline, and `dozebox-boot` failing loudly.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeClock, makeFakeExec, type ExecScript } from "@dozebox/testkit/fakes";
import { ATTACH_WAIT_MS, attachDataVolume } from "../src/boot/attach.ts";
import { mountDataVolume, resolveDataDevice } from "../src/boot/mount.ts";
import { FORMATTED_RECORD, formattedFor, runBoot } from "../src/boot/run.ts";
import { makeBootTimeline, parseSteps, TIMELINE_PATH } from "../src/boot/timeline.ts";
import type { AttachedVolume, VolumeAttach } from "../src/ports/volumes.ts";
import { flush, harness, IDENTITY } from "./support.ts";

const ME = { boxId: "box-1", instanceId: "i-0123456789abcdef0", zone: "us-east-1a" };
const OTHER = "i-0fedcba9876543210";
const h0 = (): number => Date.parse("2026-11-25T00:00:00.000Z") - 10_000;

function volumes(start: AttachedVolume | null, opts: { deny?: boolean } = {}) {
  let v = start;
  const calls: string[] = [];
  const port: VolumeAttach = {
    findActive: async () => v,
    describe: async () => v,
    attach: async (o) => {
      calls.push(`attach:${o.volumeId}:${o.device}`);
      if (opts.deny) throw new RunnerError("aws_denied", false, "tag fence");
      if (v) v = { ...v, attachment: { machineId: o.machineId, state: "attached" } };
    },
  };
  return { port, calls, set: (next: AttachedVolume | null) => (v = next) };
}

const vol = (over: Partial<AttachedVolume> = {}): AttachedVolume => ({
  id: "vol-0abc",
  zone: "us-east-1a",
  active: true,
  attachment: null,
  ...over,
});

test("attach: refuses no volume, a volume not active, a volume in another zone", async () => {
  const clock = makeFakeClock();
  const sig = new AbortController().signal;
  const cases: Array<[AttachedVolume | null, string]> = [
    [null, "no-active-volume"],
    [vol({ active: false }), "not-active"],
    [vol({ zone: "us-east-1b" }), "wrong-zone"],
  ];
  for (const [v, why] of cases) {
    const f = volumes(v);
    assert.deepEqual(await attachDataVolume({ volumes: f.port, clock }, ME, sig), { kind: "refused", why });
    assert.deepEqual(f.calls, []);
  }
  const denied = volumes(vol(), { deny: true });
  assert.deepEqual(await attachDataVolume({ volumes: denied.port, clock }, ME, sig), {
    kind: "refused",
    why: "not-active",
  });
});

test("attach: a free volume is attached as /dev/sdf; our own attachment is reused", async () => {
  const clock = makeFakeClock();
  const f = volumes(vol());
  const out = await attachDataVolume({ volumes: f.port, clock }, ME, new AbortController().signal);
  assert.deepEqual(out, { kind: "attached", volumeId: "vol-0abc", device: "/dev/sdf" });
  assert.deepEqual(f.calls, ["attach:vol-0abc:/dev/sdf"]);
  await attachDataVolume({ volumes: f.port, clock }, ME, new AbortController().signal);
  assert.equal(f.calls.length, 1);
});

test("attach: waits for another machine to let go, never detaches it, gives up after ATTACH_WAIT_MS", async () => {
  const clock = makeFakeClock();
  const f = volumes(vol({ attachment: { machineId: OTHER, state: "detaching" } }));
  const p = attachDataVolume({ volumes: f.port, clock }, ME, new AbortController().signal);
  await flush();
  clock.advance(10_000);
  f.set(vol());
  clock.advance(5_000);
  assert.equal((await p).kind, "attached");

  const stuck = volumes(vol({ attachment: { machineId: OTHER, state: "attached" } }));
  const q = attachDataVolume({ volumes: stuck.port, clock }, ME, new AbortController().signal);
  for (let t = 0; t <= ATTACH_WAIT_MS; t += 5_000) {
    await flush();
    clock.advance(5_000);
  }
  assert.deepEqual(await q, { kind: "refused", why: "attached-elsewhere" });
  assert.deepEqual(stuck.calls, []);
});

function mountExec(blkid: { code: number; stdout?: string }, mounted = false) {
  const scripts: ExecScript[] = [
    { match: ["findmnt"], outcome: { code: mounted ? 0 : 1 } },
    { match: ["blkid"], outcome: blkid },
    { match: () => true, outcome: { code: 0 } },
  ];
  return makeFakeExec(scripts);
}

test("mount: a blank volume without the record is formatted once and recorded", async () => {
  let recorded = false;
  const exec = mountExec({ code: 2 });
  const deps = {
    exec,
    formatted: async () => recorded,
    markFormatted: async () => void (recorded = true),
  };
  const out = await mountDataVolume(deps, "/dev/nvme1n1", new AbortController().signal);
  assert.deepEqual(out, { formatted: true, mountedAt: "/data" });
  assert.ok(recorded);
  const argv = exec.calls.map((c) => c.argv.join(" "));
  assert.ok(argv.includes("mkfs.ext4 -q -L dozebox-data /dev/nvme1n1"));
  assert.ok(argv.includes("mount -o noatime /dev/nvme1n1 /data"));
  assert.ok(argv.includes("install -d -m 0700 /data/dozebox"));
});

test("mount: the formatted record prevents a second mkfs even when blkid sees nothing", async () => {
  const exec = mountExec({ code: 2 });
  const deps = { exec, formatted: async () => true, markFormatted: async () => assert.fail("no mark") };
  await assert.rejects(mountDataVolume(deps, "/dev/nvme1n1", new AbortController().signal), /refusing mkfs/);
  assert.equal(exec.of("mkfs.ext4").length, 0);
  assert.equal(exec.of("mount").length, 0);
});

test("mount: an existing filesystem is adopted (recorded, never formatted); a mounted /data is left alone", async () => {
  let marks = 0;
  const exec = mountExec({ code: 0, stdout: "ext4\n" });
  const deps = { exec, formatted: async () => false, markFormatted: async () => void marks++ };
  assert.deepEqual(await mountDataVolume(deps, "/dev/sdf", new AbortController().signal), {
    formatted: false,
    mountedAt: "/data",
  });
  assert.equal(marks, 1);
  assert.equal(exec.of("mkfs.ext4").length, 0);
  const again = mountExec({ code: 0, stdout: "ext4" }, true);
  await mountDataVolume({ ...deps, exec: again }, "/dev/sdf", new AbortController().signal);
  assert.deepEqual([again.of("blkid").length, again.of("mount").length], [0, 0]);
});

test("device: the NVMe by-id name of the volume first, then /dev/sdf", async () => {
  const clock = makeFakeClock();
  const seen = new Set(["/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0abc"]);
  const exists = async (p: string) => seen.has(p);
  const sig = new AbortController().signal;
  assert.equal(
    await resolveDataDevice({ exists, clock }, "vol-0abc", "/dev/sdf", sig),
    "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0abc",
  );
  seen.clear();
  seen.add("/dev/xvdf");
  assert.equal(await resolveDataDevice({ exists, clock }, "vol-0abc", "/dev/sdf", sig), "/dev/xvdf");
});

test("timeline: steps from every process, ok false on a throw, published with uptime offsets", async () => {
  const h = harness({
    files: {
      [TIMELINE_PATH]: `${JSON.stringify({ step: "stage0", startedAt: h0() + 1_000, ms: 2_000, ok: true })}\nnot json\n`,
    },
  });
  const t = makeBootTimeline({ clock: h.clock, records: h.deps.records, files: h.files, bootAt: h0() });
  await t.step("attach", async () => h.clock.advance(1_500));
  await assert.rejects(
    t.step("mount", async () => {
      throw new Error("no device");
    }),
  );
  assert.deepEqual(
    (await t.steps()).map((s) => [s.step, s.ok]),
    [
      ["stage0", true],
      ["attach", true],
      ["mount", false],
    ],
  );
  await t.publish();
  const rec = JSON.parse(h.records.get("rec/boot-timeline") ?? "null");
  assert.equal(rec.ok, false);
  assert.equal(rec.upSeconds, 11.5);
  assert.deepEqual(rec.steps[0], { step: "stage0", ms: 2000, upStart: 1, upEnd: 3 });
  assert.deepEqual(rec.steps[1], { step: "attach", ms: 1500, upStart: 10, upEnd: 11.5 });
  assert.deepEqual(parseSteps('{"step":"Bad Name","startedAt":1,"ms":1,"ok":true}'), []);
});

test("dozebox-boot: refused attach -> rec/last-error boot:attach, timeline, exit 1; success writes rec/formatted", async () => {
  const h = harness();
  const refused = volumes(null);
  const deps = {
    ...h.deps,
    volumes: refused.port,
    exists: async () => true,
    identity: IDENTITY,
  };
  assert.equal(await runBoot(deps, new AbortController().signal), 1);
  const err = JSON.parse(h.records.get("rec/last-error") ?? "null");
  assert.deepEqual([err.source, err.message], ["boot:attach", "attach refused: no-active-volume"]);
  assert.equal(JSON.parse(h.records.get("rec/boot-timeline") ?? "null").ok, false);

  const ok = harness();
  const exec = mountExec({ code: 2 });
  const code = await runBoot(
    { ...ok.deps, exec, volumes: volumes(vol()).port, exists: async () => true, identity: IDENTITY },
    new AbortController().signal,
  );
  assert.equal(code, 0);
  const formatted = JSON.parse(ok.records.get(FORMATTED_RECORD) ?? "null");
  assert.equal(formatted.volumeId, "vol-0abc");
  ok.params.set(FORMATTED_RECORD, JSON.stringify(formatted));
  assert.equal(await formattedFor(ok.deps.params, "vol-0abc"), true);
  assert.equal(await formattedFor(ok.deps.params, "vol-0other"), false);
});
