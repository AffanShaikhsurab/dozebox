import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeFakeExec, makeFakeFs } from "@dozebox/testkit/fakes";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";
import { CURRENT_LINK, sha256Hex, updateAgent, type UpdateDeps, type UpdateOutcome } from "../src/update/index.ts";

const BYTES = new TextEncoder().encode("release archive bytes");
const GOOD = { version: "1.1.0", url: "https://releases.example/dozebox-agent-1.1.0.tar.gz", sha256: sha256Hex(BYTES) };

function setup(opts: { readonly ready?: boolean[]; readonly fetchFails?: boolean; readonly status?: number } = {}) {
  const exec = makeFakeExec([{ match: () => true, outcome: { code: 0 } }]);
  const ready = [...(opts.ready ?? [true])];
  const written: string[] = [];
  const reports: UpdateOutcome[] = [];
  const fetchCalls: string[] = [];
  const deps: UpdateDeps = {
    exec,
    files: makeNodeFiles(makeFakeFs().fs.promises as unknown as FsPromises, 1),
    fetch: (async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      if (opts.fetchFails) throw new Error("ECONNRESET");
      return new Response(BYTES, { status: opts.status ?? 200 });
    }) as typeof fetch,
    current: async () => "1.0.0",
    waitReady: async () => ready.shift() ?? false,
    writeBytes: async (path) => void written.push(path),
    report: async (o) => void reports.push(o),
  };
  const argv = () => exec.calls.map((c) => c.argv.join(" "));
  return { deps, exec, written, reports, fetchCalls, argv };
}

const signal = new AbortController().signal;

describe("updateAgent", () => {
  it("does nothing when the target is the running version", async () => {
    const t = setup();
    assert.deepEqual(await updateAgent(t.deps, { ...GOOD, version: "1.0.0" }, signal), {
      kind: "unchanged",
      version: "1.0.0",
    });
    assert.equal(t.fetchCalls.length, 0);
  });

  it("refuses a bad checksum before touching the disk", async () => {
    const t = setup();
    const out = await updateAgent(t.deps, { ...GOOD, sha256: "0".repeat(64) }, signal);
    assert.deepEqual(out, { kind: "refused", why: "checksum" });
    assert.equal(t.exec.calls.length, 0);
    assert.deepEqual(t.written, []);
  });

  it("refuses when the download fails or answers non-2xx", async () => {
    assert.deepEqual(await updateAgent(setup({ fetchFails: true }).deps, GOOD, signal), {
      kind: "refused",
      why: "download",
    });
    assert.deepEqual(await updateAgent(setup({ status: 404 }).deps, GOOD, signal), {
      kind: "refused",
      why: "download",
    });
  });

  it("unpacks, switches the link with one rename, restarts and reports the switch", async () => {
    const t = setup();
    const out = await updateAgent(t.deps, GOOD, signal);
    assert.deepEqual(out, { kind: "switched", from: "1.0.0", to: "1.1.0" });
    assert.deepEqual(t.written, ["/opt/dozebox/releases/1.1.0.tar.gz"]);
    assert.deepEqual(t.argv(), [
      "mkdir -p /opt/dozebox/releases/1.1.0",
      "tar -xzf /opt/dozebox/releases/1.1.0.tar.gz -C /opt/dozebox/releases/1.1.0 --no-same-owner",
      "rm -f /opt/dozebox/releases/1.1.0.tar.gz",
      `ln -sfn /opt/dozebox/releases/1.1.0 ${CURRENT_LINK}.next`,
      `mv -Tf ${CURRENT_LINK}.next ${CURRENT_LINK}`,
      "systemctl restart --no-block dozeboxd.service",
    ]);
    assert.deepEqual(t.reports, [out]);
  });

  it("rolls back to the previous release when the new agent misses READY=1", async () => {
    const t = setup({ ready: [false, true] });
    const out = await updateAgent(t.deps, GOOD, signal);
    assert.equal(out.kind, "rolled-back");
    assert.deepEqual(out.kind === "rolled-back" && { from: out.from, to: out.to }, { from: "1.1.0", to: "1.0.0" });
    assert.match(out.kind === "rolled-back" ? out.why : "", /1\.1\.0 did not send READY=1 within 120 s$/);
    assert.deepEqual(t.argv().slice(-3), [
      `ln -sfn /opt/dozebox/releases/1.0.0 ${CURRENT_LINK}.next`,
      `mv -Tf ${CURRENT_LINK}.next ${CURRENT_LINK}`,
      "systemctl restart --no-block dozeboxd.service",
    ]);
    assert.deepEqual(t.reports, [out]);
  });

  it("says so when the old release does not come back either", async () => {
    const out = await updateAgent(setup({ ready: [false, false] }).deps, GOOD, signal);
    assert.match(out.kind === "rolled-back" ? out.why : "", /1\.0\.0 did not either/);
  });

  it("a failing report does not undo the update", async () => {
    const t = setup();
    const out = await updateAgent(
      { ...t.deps, report: async () => Promise.reject(new Error("ssm down")) },
      GOOD,
      signal,
    );
    assert.equal(out.kind, "switched");
  });

  it("refuses a version that is not a plain name and a non-https url", async () => {
    await assert.rejects(updateAgent(setup().deps, { ...GOOD, version: "../../etc" }, signal), TypeError);
    await assert.rejects(updateAgent(setup().deps, { ...GOOD, url: "http://x/a.tgz" }, signal), TypeError);
  });

  it("a failed unpack throws and leaves the link alone", async () => {
    const t = setup();
    const exec = makeFakeExec([
      { match: ["tar"], outcome: { code: 2, stderr: "gzip: not in gzip format" } },
      { match: () => true, outcome: { code: 0 } },
    ]);
    await assert.rejects(updateAgent({ ...t.deps, exec }, GOOD, signal), /not in gzip format/);
    assert.ok(!exec.calls.some((c) => c.argv[0] === "ln"));
  });
});
