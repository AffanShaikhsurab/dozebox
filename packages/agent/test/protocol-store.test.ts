import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeFakeFs } from "@dozebox/testkit/fakes";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";
import { ProtocolError } from "../src/protocol/errors.ts";
import { LIMITS } from "../src/protocol/limits.ts";
import { makeProtocolStore, type ProtocolStoreDeps } from "../src/protocol/store.ts";

const T0 = Date.parse("2026-11-25T00:00:00.000Z");
const MIN = 60_000;
const at = (ms: number): string => new Date(ms).toISOString();
const PATH = "/data/dozebox/protocol.json";

function setup(over: Partial<ProtocolStoreDeps> = {}, seed: Record<string, string> = {}) {
  const fake = makeFakeFs(seed);
  const files = makeNodeFiles(fake.fs.promises as unknown as FsPromises, 1);
  const make = (more: Partial<ProtocolStoreDeps> = {}) =>
    makeProtocolStore({ files, path: PATH, bootId: "boot-a", ...over, ...more });
  return { make, files, fake };
}

const refused = (code: string, field?: string) => (e: unknown) => {
  assert.ok(e instanceof ProtocolError, String(e));
  assert.equal(e.code, code);
  if (field !== undefined) assert.equal(e.field, field);
  return true;
};

describe("protocol store: holds", () => {
  it("creates a hold with since = now and grants the request", async () => {
    const s = await setup().make();
    const h = await s.putHold("web", "run-42", { reason: "r", until: at(T0 + 30 * MIN) }, T0);
    assert.deepEqual(h, {
      id: "run-42",
      reason: "r",
      kind: "work",
      since: at(T0),
      requestedUntil: at(T0 + 30 * MIN),
      until: at(T0 + 30 * MIN),
      clamped: false,
    });
  });

  it("renewing keeps since and replaces reason, kind and requestedUntil", async () => {
    const s = await setup().make();
    await s.putHold("web", "a", { reason: "one", until: at(T0 + 10 * MIN) }, T0);
    const h = await s.putHold("web", "a", { reason: "two", kind: "wait", until: at(T0 + 40 * MIN) }, T0 + 5 * MIN);
    assert.equal(h.since, at(T0));
    assert.equal(h.reason, "two");
    assert.equal(h.kind, "wait");
    assert.equal(h.until, at(T0 + 40 * MIN));
  });

  it("an expired id counts as new", async () => {
    const s = await setup().make();
    await s.putHold("web", "a", { reason: "r", until: at(T0 + MIN) }, T0);
    const h = await s.putHold("web", "a", { reason: "r", until: at(T0 + 10 * MIN) }, T0 + 2 * MIN);
    assert.equal(h.since, at(T0 + 2 * MIN));
  });

  it("clamps to since + maxSeconds and to the payload's holdMaxSeconds", async () => {
    const s = await setup({ holdMaxSeconds: () => 3600 }).make();
    const a = await s.putHold("web", "a", { reason: "r", until: at(T0 + 120 * MIN), maxSeconds: 600 }, T0);
    assert.equal(a.until, at(T0 + 10 * MIN));
    assert.equal(a.clamped, true);
    const b = await s.putHold("web", "b", { reason: "r", until: at(T0 + 120 * MIN), maxSeconds: 86400 }, T0);
    assert.equal(b.until, at(T0 + 60 * MIN));
    const renewed = await s.putHold(
      "web",
      "a",
      { reason: "r", until: at(T0 + 120 * MIN), maxSeconds: 600 },
      T0 + 9 * MIN,
    );
    assert.equal(renewed.until, at(T0 + 10 * MIN), "renewing past maxSeconds has no effect");
  });

  it("clamps to the awake cap and reports it", async () => {
    const clamped: string[] = [];
    const s = await setup({
      holdCapAt: () => T0 + 5 * MIN,
      onClamped: (p, id, until) => clamped.push(`${p}/${id}@${at(until)}`),
    }).make();
    const h = await s.putHold("web", "a", { reason: "r", until: at(T0 + 60 * MIN) }, T0);
    assert.equal(h.until, at(T0 + 5 * MIN));
    assert.equal(h.clamped, true);
    assert.deepEqual(clamped, [`web/a@${at(T0 + 5 * MIN)}`]);
    const past = await setup({ holdCapAt: () => T0 - MIN }).make();
    assert.equal((await past.putHold("web", "a", { reason: "r", until: at(T0 + MIN) }, T0)).until, at(T0));
  });

  it("refuses until in the past and the 65th live hold", async () => {
    const s = await setup().make();
    await assert.rejects(s.putHold("web", "a", { reason: "r", until: at(T0) }, T0), refused("invalid_value", "until"));
    for (let i = 0; i < LIMITS.holdsPerPayload; i++)
      await s.putHold("web", `h${i}`, { reason: "r", until: at(T0 + MIN) }, T0);
    await assert.rejects(
      s.putHold("web", "one-more", { reason: "r", until: at(T0 + MIN) }, T0),
      refused("limit_exceeded"),
    );
    await s.putHold("web", "h0", { reason: "renew", until: at(T0 + MIN) }, T0);
    await s.putHold("api", "h0", { reason: "other payload", until: at(T0 + MIN) }, T0);
  });

  it("ids are scoped to the payload; delete reports whether it existed", async () => {
    const s = await setup().make();
    await s.putHold("web", "ci", { reason: "r", until: at(T0 + MIN) }, T0);
    await s.putHold("api", "ci", { reason: "r", until: at(T0 + MIN) }, T0);
    assert.equal(await s.deleteHold("web", "ci"), true);
    assert.equal(await s.deleteHold("web", "ci"), false);
    assert.deepEqual(
      s.listHolds(null, T0).map((h) => h.id),
      ["ci"],
    );
    assert.deepEqual(await s.holds(T0), [{ key: "api/ci", kind: "work", until: T0 + MIN }]);
  });

  it("expired holds are left out of lists and the HoldSource", async () => {
    const s = await setup().make();
    await s.putHold("web", "a", { reason: "r", until: at(T0 + MIN) }, T0);
    assert.equal(s.listHolds("web", T0 + MIN).length, 0);
    assert.deepEqual(await s.holds(T0 + MIN), []);
  });
});

describe("protocol store: persistence", () => {
  it("an agent restart in the same boot keeps holds, wakes, presence and beats", async () => {
    const env = setup();
    const a = await env.make();
    await a.putHold("web", "a", { reason: "r", until: at(T0 + 10 * MIN) }, T0);
    await a.putWake("web", "w", { reason: "r", at: at(T0 + 60 * MIN) }, T0);
    await a.putPresence("web", "tab", { until: at(T0 + 5 * MIN), kind: "interactive" }, T0);
    await a.beats("web", [{ kind: "progress", name: "turn" }], T0);
    const b = await env.make();
    assert.deepEqual(b.listHolds("web", T0), a.listHolds("web", T0));
    assert.deepEqual(b.listWakes("web", T0), a.listWakes("web", T0));
    assert.deepEqual(await b.presence(T0), [{ key: "web/tab", kind: "interactive", until: T0 + 5 * MIN }]);
    assert.equal(await b.lastProgressAt(), T0);
    assert.equal(await b.lastInteractiveAt(), T0);
  });

  it("a new boot id clears everything and rewrites the file", async () => {
    const env = setup();
    const a = await env.make();
    await a.putHold("web", "a", { reason: "r", until: at(T0 + 10 * MIN) }, T0);
    await a.putWake("web", "w", { reason: "r", at: at(T0 + 60 * MIN) }, T0);
    const b = await env.make({ bootId: "boot-b" });
    assert.deepEqual(b.listHolds(null, T0), []);
    assert.deepEqual(b.listWakes(null, T0), []);
    const file = JSON.parse((await env.files.readText(PATH)) ?? "{}") as { bootId: string; holds: unknown[] };
    assert.equal(file.bootId, "boot-b");
    assert.deepEqual(file.holds, []);
  });

  it("a corrupt file starts empty", async () => {
    const s = await setup({}, { [PATH]: "{not json" }).make();
    assert.deepEqual(s.listHolds(null, T0), []);
  });

  it("each change is on disk when the call resolves", async () => {
    const env = setup();
    const s = await env.make();
    await s.putHold("web", "a", { reason: "r", until: at(T0 + MIN) }, T0);
    assert.match((await env.files.readText(PATH)) ?? "", /"id":"a"/);
    await s.deleteHold("web", "a");
    assert.doesNotMatch((await env.files.readText(PATH)) ?? "", /"id":"a"/);
  });
});

describe("protocol store: wakes", () => {
  it("needs at or on", async () => {
    const s = await setup().make();
    await assert.rejects(s.putWake("web", "w", { reason: "r" }, T0), refused("invalid_value", "at"));
  });

  it("defaults expiresAt to at + 1 h for timed and now + 7 d for event wakes", async () => {
    const s = await setup().make();
    const timed = await s.putWake("web", "t", { reason: "r", at: at(T0 + 60 * MIN) }, T0);
    assert.equal(timed.expiresAt, at(T0 + 120 * MIN));
    const on = { source: "webhook" as const, topic: "deploy" };
    const ev = await s.putWake("web", "e", { reason: "r", on }, T0);
    assert.equal(ev.expiresAt, at(T0 + 7 * 24 * 60 * MIN));
    assert.deepEqual(ev.on, on);
  });

  it("accepts an at in the past, refuses one past the 35-day horizon", async () => {
    const s = await setup().make();
    await s.putWake("web", "asap", { reason: "r", at: at(T0 - MIN) }, T0);
    await assert.rejects(
      s.putWake("web", "far", { reason: "r", at: at(T0 + 36 * 24 * 60 * MIN) }, T0),
      refused("invalid_value", "at"),
    );
  });

  it("refuses a past expiresAt", async () => {
    const s = await setup().make();
    await assert.rejects(
      s.putWake("web", "w", { reason: "r", at: at(T0 + MIN), expiresAt: at(T0 - MIN) }, T0),
      refused("invalid_value", "expiresAt"),
    );
  });

  it("PUT replaces; 10 per payload and 20 per box", async () => {
    const s = await setup().make();
    for (let i = 0; i < 10; i++) await s.putWake("a", `w${i}`, { reason: "r", at: at(T0 + MIN) }, T0);
    await s.putWake("a", "w0", { reason: "replaced", at: at(T0 + MIN) }, T0);
    assert.equal(s.listWakes("a", T0).find((w) => w.id === "w0")?.reason, "replaced");
    await assert.rejects(s.putWake("a", "w10", { reason: "r", at: at(T0 + MIN) }, T0), refused("limit_exceeded"));
    for (let i = 0; i < 10; i++) await s.putWake("b", `w${i}`, { reason: "r", at: at(T0 + MIN) }, T0);
    await assert.rejects(s.putWake("c", "w", { reason: "r", at: at(T0 + MIN) }, T0), refused("limit_exceeded"));
  });

  it("refuses a set that would not fit in rec/wakes", async () => {
    const s = await setup().make();
    const reason = "x".repeat(120);
    const on = {
      source: "github" as const,
      repository: `${"o".repeat(39)}/${"n".repeat(100)}`,
      events: Array.from({ length: 8 }, (_, i) => `${"e".repeat(39)}${i}`.slice(0, 40).replace(/\d/, "_")),
      actions: Array.from({ length: 8 }, () => "a".repeat(40)),
    };
    let refusedAt = -1;
    for (let i = 0; i < 20; i++) {
      try {
        await s.putWake(`p${i % 4}`, `w${i}`, { reason, on }, T0);
      } catch (e) {
        refused("limit_exceeded")(e);
        refusedAt = i;
        break;
      }
    }
    assert.ok(refusedAt > 0 && refusedAt < 20, `refused at ${refusedAt}`);
  });

  it("wakeRequests carries the payload for rec/wakes", async () => {
    const s = await setup().make();
    await s.putWake("web", "w", { reason: "r", at: at(T0 + MIN) }, T0);
    assert.deepEqual(await s.wakeRequests(), [
      { payload: "web", id: "w", reason: "r", at: at(T0 + MIN), expiresAt: at(T0 + 61 * MIN) },
    ]);
  });
});

describe("protocol store: presence and beats", () => {
  it("clamps presence to now + 900 s and tracks the last interactive time", async () => {
    const s = await setup().make();
    const p = await s.putPresence("web", "tab", { until: at(T0 + 60 * MIN), kind: "viewing" }, T0);
    assert.equal(p.until, at(T0 + 15 * MIN));
    assert.equal(await s.lastInteractiveAt(), null);
    await s.putPresence("web", "tab", { until: at(T0 + 2 * MIN), kind: "interactive" }, T0 + MIN);
    assert.equal(await s.lastInteractiveAt(), T0 + MIN);
    assert.equal(await s.deletePresence("web", "tab"), true);
    assert.deepEqual(await s.presence(T0 + MIN), []);
  });

  it("runner sources are box-wide keys", async () => {
    const s = await setup().make();
    await s.putPresence("runner", "src:ssh", { until: at(T0 + MIN), kind: "interactive" }, T0);
    assert.deepEqual(await s.presence(T0), [{ key: "src:ssh", kind: "interactive", until: T0 + MIN }]);
  });

  it("keeps the newest beat per name and ignores older ones", async () => {
    const s = await setup().make();
    await s.beats("web", [{ kind: "progress", name: "turn", at: at(T0) }], T0);
    await s.beats("web", [{ kind: "progress", name: "turn", at: at(T0 - MIN) }], T0);
    assert.deepEqual(s.beatsOf("web", T0).progress, { turn: T0 });
    assert.equal(await s.lastProgressAt(), T0);
  });

  it("loop beats never move the progress clock; a missed loop is reported", async () => {
    const s = await setup().make();
    await s.beats("web", [{ kind: "loop", name: "watcher", expectEverySeconds: 60 }], T0);
    assert.equal(await s.lastProgressAt(), null);
    assert.deepEqual(s.beatsOf("web", T0 + MIN).missedLoops, []);
    assert.deepEqual(s.beatsOf("web", T0 + MIN + 1).missedLoops, ["watcher"]);
  });

  it("refuses beats outside 5 min back and 5 s ahead, and the 33rd name", async () => {
    const s = await setup().make();
    await assert.rejects(
      s.beats("web", [{ kind: "progress", name: "a", at: at(T0 - 6 * MIN) }], T0),
      refused("invalid_value", "beats[0].at"),
    );
    await assert.rejects(
      s.beats("web", [{ kind: "progress", name: "a", at: at(T0 + 6000) }], T0),
      refused("invalid_value", "beats[0].at"),
    );
    await s.beats(
      "web",
      Array.from({ length: 32 }, (_, i) => ({ kind: "loop" as const, name: `l${i}` })),
      T0,
    );
    await assert.rejects(s.beats("web", [{ kind: "progress", name: "new" }], T0), refused("limit_exceeded"));
  });

  it("self-reported health counts until its ttl", async () => {
    const s = await setup().make();
    await s.putHealth("web", { ok: false, detail: "store unreadable", ttlSeconds: 120 }, T0);
    assert.deepEqual(s.healthOf("web", T0 + MIN), { ok: false, detail: "store unreadable" });
    assert.equal(s.healthOf("web", T0 + 2 * MIN), null);
  });
});
