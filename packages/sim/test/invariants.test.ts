// S2: the six protocol invariants. Each has a hand-made trace that breaks it and one that keeps it, and a seeded
// census on a deliberately broken agent that trips it (and only the correct agent's census stays clean).
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SimBug } from "../src/config.ts";
import { checkInvariants, NO_PROGRESS_MS, type InvariantId, type TraceEvent } from "../src/invariants.ts";
import { censusOf, runSeed } from "../src/run.ts";

const M = 60_000;
const ids = (t: ReadonlyArray<TraceEvent>): InvariantId[] => checkInvariants(t).map((v) => v.id);
const boot = (at: number): TraceEvent => ({ at, kind: "serving", key: "i-1" });
const park = (at: number, key: string, bootAt: number): TraceEvent => ({ at, kind: "park", key, until: bootAt });

describe("protocol invariants on hand-made traces", () => {
  it("no-park-while-held: an idle park under a live hold", () => {
    const held = [boot(0), { at: M, kind: "hold", key: "work:1", until: 20 * M } as const];
    assert.deepEqual(ids([...held, park(10 * M, "idle", 0)]), ["no-park-while-held"]);
    assert.deepEqual(ids([...held, { at: 5 * M, kind: "release", key: "work:1" }, park(10 * M, "idle", 0)]), []);
    assert.deepEqual(ids([...held, park(10 * M, "unhealthy", 0)]), []);
  });

  it("no-park-while-present: an idle or no-progress park while a person is present", () => {
    const present = [boot(0), { at: M, kind: "presence", key: "interactive:tab", until: 11 * M } as const];
    assert.deepEqual(ids([...present, park(5 * M, "no-progress", 0)]), ["no-park-while-present"]);
    assert.deepEqual(ids([...present, park(12 * M, "idle", 0)]), []);
    const viewing = [boot(0), { at: M, kind: "presence", key: "viewing:tab", until: 11 * M } as const];
    assert.deepEqual(ids([...viewing, park(5 * M, "idle", 0)]), []);
  });

  it("wake-request-honoured: a request live at the park needs a wake within [at - 1 min, at + 30 min]", () => {
    const left = [
      boot(0),
      { at: M, kind: "wake-request", key: "wake:1", until: 120 * M } as const,
      park(10 * M, "idle", 0),
    ];
    const end: TraceEvent = { at: 200 * M, kind: "beat" };
    assert.deepEqual(ids([...left, end]), ["wake-request-honoured"]);
    assert.deepEqual(ids([...left, { at: 119.5 * M, kind: "wake", key: "wake:1" }, end]), []);
    const cancelled = [
      boot(0),
      left[1] as TraceEvent,
      { at: 2 * M, kind: "release", key: "wake:1" } as const,
      park(10 * M, "idle", 0),
    ];
    assert.deepEqual(ids([...cancelled, end]), []);
  });

  it("progress-or-park: serving with no beat, work hold or presence past the no-progress time plus 15 minutes", () => {
    const stuck = [boot(0), { at: M, kind: "hold", key: "wait:1", until: NO_PROGRESS_MS * 2 } as const];
    assert.deepEqual(ids([...stuck, park(NO_PROGRESS_MS + 20 * M, "no-progress", 0)]), ["progress-or-park"]);
    assert.deepEqual(ids([...stuck, park(NO_PROGRESS_MS + 5 * M, "no-progress", 0)]), []);
    const beating = [...stuck, { at: NO_PROGRESS_MS, kind: "beat" } as const];
    assert.deepEqual(ids([...beating, park(NO_PROGRESS_MS + 20 * M, "no-progress", 0)]), []);
  });

  it("holds-cleared-on-boot: a hold from the boot before comes back unrenewed", () => {
    const first = [boot(0), { at: M, kind: "hold", key: "work:1", until: 300 * M } as const, park(10 * M, "down", 0)];
    assert.deepEqual(ids([...first, boot(20 * M), { at: 20.2 * M, kind: "hold", key: "work:1", until: 300 * M }]), [
      "holds-cleared-on-boot",
    ]);
    assert.deepEqual(ids([...first, boot(20 * M), { at: 25 * M, kind: "hold", key: "work:1", until: 40 * M }]), []);
  });

  it("one-park-per-boot: a second park of the same boot, minutes after the first", () => {
    assert.deepEqual(ids([boot(0), park(30 * M, "idle", 0), park(40 * M, "idle", 0)]), ["one-park-per-boot"]);
    assert.deepEqual(ids([boot(0), park(30 * M, "idle", 0), park(30.2 * M, "down", 0)]), []);
    assert.deepEqual(ids([boot(0), park(30 * M, "idle", 0), boot(50 * M), park(80 * M, "idle", 50 * M)]), []);
  });
});

const BROKEN: ReadonlyArray<readonly [SimBug, InvariantId]> = [
  ["agent-ignores-holds", "no-park-while-held"],
  ["agent-ignores-presence", "no-park-while-present"],
  ["agent-drops-wake-requests", "wake-request-honoured"],
  ["agent-ignores-no-progress", "progress-or-park"],
  ["agent-keeps-holds", "holds-cleared-on-boot"],
  ["agent-double-park", "one-park-per-boot"],
];

describe("protocol invariants on a broken agent", () => {
  for (const [bug, id] of BROKEN) {
    it(`${bug} trips ${id}`, () => {
      const c = censusOf(Array.from({ length: 120 }, (_, i) => runSeed(i + 1, { bugs: [bug] })));
      assert.ok((c.byClass[`protocol/${id}`] ?? 0) > 0, JSON.stringify(c.byClass));
    });
  }

  it("the correct agent trips none of them", () => {
    const c = censusOf(Array.from({ length: 300 }, (_, i) => runSeed(i + 1)));
    assert.deepEqual(
      Object.keys(c.byClass).filter((k) => k.startsWith("protocol/")),
      [],
    );
  });
});
