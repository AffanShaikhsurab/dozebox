// A2 event hub: ids, replay window, since() rules, schema refusal, visibility.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeEventHub } from "../src/protocol/events.ts";

const PHASE = { phase: "serving", since: "2026-11-25T00:00:00.000Z" };
const DISK = { level: "ok", freePct: 40 };

test("ids are <bootId>-<n> from 1 and publish returns the event", () => {
  const hub = makeEventHub({ bootId: "boot-a" });
  assert.deepEqual(hub.publish("disk", DISK), { id: "boot-a-1", name: "disk", data: DISK, payload: null });
  assert.equal(hub.publish("disk", DISK, "pl").id, "boot-a-2");
  assert.equal(hub.publish("disk", DISK, "pl").payload, "pl");
});

test("only the newest `limit` events are kept", () => {
  const hub = makeEventHub({ bootId: "b", limit: 3 });
  for (let i = 0; i < 5; i++) hub.publish("disk", DISK);
  assert.deepEqual(
    hub.since("b-1", null).map((e) => e.id),
    ["b-3", "b-4", "b-5"],
  );
});

test("since: null, another boot and non-ids replay nothing; old id of this boot replays all kept", () => {
  const hub = makeEventHub({ bootId: "b", limit: 2 });
  for (let i = 0; i < 4; i++) hub.publish("disk", DISK);
  assert.deepEqual(hub.since(null, null), []);
  assert.deepEqual(hub.since("other-1", null), []);
  assert.deepEqual(hub.since("b-x", null), []);
  assert.deepEqual(hub.since("", null), []);
  assert.deepEqual(
    hub.since("b-1", null).map((e) => e.id),
    ["b-3", "b-4"],
  );
  assert.deepEqual(
    hub.since("b-3", null).map((e) => e.id),
    ["b-4"],
  );
  assert.deepEqual(hub.since("b-4", null), []);
  assert.deepEqual(hub.since("b-99", null), []);
});

test("an unknown name or data off its schema throws TypeError and keeps nothing", () => {
  const hub = makeEventHub({ bootId: "b" });
  assert.throws(() => hub.publish("nope", {}), TypeError);
  assert.throws(() => hub.publish("toString", {}), TypeError);
  assert.throws(() => hub.publish("disk", { level: "ok" }), TypeError);
  assert.throws(() => hub.publish("phase", PHASE.phase), TypeError);
  assert.deepEqual(hub.since("b-0", null), []);
  assert.equal(hub.publish("phase", PHASE).id, "b-1");
});

test("visibility: admin sees all, a payload sees broadcast and its own", () => {
  const hub = makeEventHub({ bootId: "b" });
  const seen: { admin: string[]; x: string[]; y: string[] } = { admin: [], x: [], y: [] };
  hub.subscribe(null, (e) => seen.admin.push(e.id));
  hub.subscribe("x", (e) => seen.x.push(e.id));
  const offY = hub.subscribe("y", (e) => seen.y.push(e.id));
  hub.publish("disk", DISK);
  hub.publish("disk", DISK, "x");
  offY();
  hub.publish("disk", DISK, "y");
  assert.deepEqual(seen, { admin: ["b-1", "b-2", "b-3"], x: ["b-1", "b-2"], y: ["b-1"] });
  assert.deepEqual(
    hub.since("b-0", "x").map((e) => e.id),
    ["b-1", "b-2"],
  );
  assert.deepEqual(
    hub.since("b-0", "y").map((e) => e.id),
    ["b-1", "b-3"],
  );
  assert.equal(hub.since("b-0", null).length, 3);
});
