// C6: the weekly restore test state machine: due or not, one volume per start, close from the start time, verify result.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  makeRestoreTest,
  RESTORE_INTERVAL_MS,
  type RestoreTestDeps,
  type RestoreTestState,
} from "../src/restore-test/run.ts";

const CLOSE = 3_600_000;
const WEEK = RESTORE_INTERVAL_MS;

const setup = (
  initial: RestoreTestState,
  opts: { snapshot?: boolean; verifyOk?: boolean; failFirstWrite?: boolean } = {},
) => {
  let state = initial;
  let failWrite = opts.failFirstWrite === true;
  const created: Array<{ boxId: string; snapshotId: string; zone: string; token: string }> = [];
  const deleted: string[] = [];
  const deps: RestoreTestDeps = {
    boxId: "main",
    closeAfterMs: CLOSE,
    read: async () => state,
    write: async (s) => {
      if (failWrite) {
        failWrite = false;
        throw new Error("write failed");
      }
      state = s;
    },
    newestSnapshot: async () => (opts.snapshot === false ? null : { id: "snap-2", zone: "us-east-1a" }),
    verify: async () => ({ ok: opts.verifyOk ?? true, detail: opts.verifyOk === false ? "bad" : "fine" }),
    deleteVolume: async (id) => void deleted.push(id),
    volumes: {
      describeBox: async () => [],
      moveActive: async () => undefined,
      createFromSnapshot: async (o) => {
        created.push(o);
        return "vol-test";
      },
    },
  };
  return { rt: makeRestoreTest(deps), created, deleted, state: () => state };
};

const last = (at: number) => ({ at, ok: true, snapshotId: "snap-1", detail: "fine" });

describe("restore test", () => {
  test("never run -> starts one volume from the newest snapshot, closeAt from now", async () => {
    const t = setup({ phase: "idle", lastResult: null });
    const s = await t.rt.step(1000, 1);
    assert.deepEqual(s, {
      phase: "running",
      startedAt: 1000,
      volumeId: "vol-test",
      snapshotId: "snap-2",
      closeAt: 1000 + CLOSE,
    });
    assert.equal(t.created.length, 1);
    assert.equal(t.created[0]?.snapshotId, "snap-2");
    assert.equal(t.created[0]?.zone, "us-east-1a");
  });

  test("last result under 7 days old -> not due, nothing created", async () => {
    const initial: RestoreTestState = { phase: "idle", lastResult: last(0) };
    const t = setup(initial);
    assert.deepEqual(await t.rt.step(WEEK - 1, 1), initial);
    assert.equal(t.created.length, 0);
  });

  test("last result 7 days old -> due", async () => {
    const t = setup({ phase: "idle", lastResult: last(0) });
    assert.equal((await t.rt.step(WEEK, 1)).phase, "running");
  });

  test("a retried start with the same snapshot sends the same token", async () => {
    const t = setup({ phase: "idle", lastResult: null }, { failFirstWrite: true });
    await assert.rejects(t.rt.step(1000, 1), /write failed/);
    await t.rt.step(1000, 2);
    assert.equal(t.created.length, 2);
    assert.equal(t.created[0]?.token, t.created[1]?.token);
  });

  test("running before closeAt -> unchanged; at closeAt -> verified, volume deleted, idle with result", async () => {
    const running: RestoreTestState = {
      phase: "running",
      startedAt: 10,
      volumeId: "vol-test",
      snapshotId: "snap-2",
      closeAt: 10 + CLOSE,
    };
    const t = setup(running);
    assert.deepEqual(await t.rt.step(10 + CLOSE - 1, 1), running);
    assert.deepEqual(t.deleted, []);
    const s = await t.rt.step(10 + CLOSE, 2);
    assert.deepEqual(s, {
      phase: "idle",
      lastResult: { at: 10 + CLOSE, ok: true, snapshotId: "snap-2", detail: "fine" },
    });
    assert.deepEqual(t.deleted, ["vol-test"]);
  });

  test("verify false -> result ok false with the detail", async () => {
    const t = setup(
      { phase: "running", startedAt: 0, volumeId: "vol-test", snapshotId: "snap-2", closeAt: 5 },
      { verifyOk: false },
    );
    const s = await t.rt.step(5, 1);
    assert.deepEqual(s.phase === "idle" ? s.lastResult : null, {
      at: 5,
      ok: false,
      snapshotId: "snap-2",
      detail: "bad",
    });
    assert.deepEqual(t.deleted, ["vol-test"]);
  });

  test("no snapshot -> idle with ok false, and not retried within a week", async () => {
    const t = setup({ phase: "idle", lastResult: null }, { snapshot: false });
    const s = await t.rt.step(100, 1);
    assert.deepEqual(s, { phase: "idle", lastResult: { at: 100, ok: false, snapshotId: "", detail: "no snapshot" } });
    assert.equal(t.created.length, 0);
    assert.deepEqual(await t.rt.step(100 + WEEK - 1, 2), s);
  });
});
