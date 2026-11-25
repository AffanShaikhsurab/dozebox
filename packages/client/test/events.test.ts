import { strict as assert } from "node:assert";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import { makeClient } from "../src/client.ts";
import type { DozeboxEvent } from "../src/index.ts";
import { noDelay, startFake } from "./fake.ts";

const sse = (res: ServerResponse): void => void res.writeHead(200, { "content-type": "text/event-stream" });
const frame = (id: string, event: string, data: unknown): string =>
  `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function collect(count: number): { events: DozeboxEvent[]; reached: Promise<void>; push: (e: DozeboxEvent) => void } {
  const events: DozeboxEvent[] = [];
  let resolve!: () => void;
  const reached = new Promise<void>((r) => (resolve = r));
  return {
    events,
    reached,
    push: (e) => {
      events.push(e);
      if (events.length === count) resolve();
    },
  };
}

test("reconnects with the Last-Event-ID of the last event, and maps names to event types", async (t) => {
  let connection = 0;
  const fake = await startFake(t, (req, res) => {
    if (req.url !== "/v1/events") return void res.writeHead(404).end();
    sse(res);
    connection += 1;
    if (connection === 1) {
      res.write(frame("b:1", "phase", { phase: "serving", since: "2026-11-24T21:00:00.000Z" }));
      res.write(frame("b:2", "ping", {}));
      res.write(frame("b:3", "disk", { level: "low", freePct: 12 }));
      res.end();
    } else {
      res.write(frame("b:4", "sleeping", { reason: "idle", at: "2026-11-24T21:00:10.000Z" }));
    }
  });
  const got = collect(3);
  const sub = makeClient({ socketPath: fake.socketPath, delay: noDelay }).events(got.push);
  t.after(() => sub.close());
  await got.reached;
  assert.deepEqual(
    got.events.map((e) => e.type),
    ["phase", "disk", "sleeping"],
  );
  const streams = fake.seen.filter((s) => s.url === "/v1/events");
  assert.equal(streams[0]?.headers["last-event-id"], undefined);
  assert.equal(streams[1]?.headers["last-event-id"], "b:3");
});

test("an unknown event name, and a known name with the wrong shape, read as unknown", async (t) => {
  const fake = await startFake(t, (req, res) => {
    if (req.url !== "/v1/events") return void res.writeHead(404).end();
    sse(res);
    res.write(frame("1", "solar-flare", { kp: 9 }));
    res.write("id: 2\nevent: disk\ndata: not json\n\n");
    res.write(frame("3", "phase", { phase: "hibernating", since: "2026-11-24T21:00:00.000Z" }));
  });
  const got = collect(3);
  const sub = makeClient({ socketPath: fake.socketPath, delay: noDelay }).events(got.push);
  t.after(() => sub.close());
  await got.reached;
  assert.deepEqual(got.events, [
    { type: "unknown", name: "solar-flare", data: { kp: 9 } },
    { type: "unknown", name: "disk", data: "not json" },
    { type: "phase", phase: "serving", since: "2026-11-24T21:00:00.000Z" },
  ]);
});

test("close stops reconnecting and a failing listener does not end the stream", async (t) => {
  let connections = 0;
  let resolveSecond!: () => void;
  const second = new Promise<void>((r) => (resolveSecond = r));
  const fake = await startFake(t, (req, res) => {
    if (req.url !== "/v1/events") return void res.writeHead(404).end();
    connections += 1;
    sse(res);
    res.write(frame(`${connections}`, "disk", { level: "ok", freePct: 50 }));
    if (connections === 1) res.end();
  });
  let delivered = 0;
  const sub = makeClient({ socketPath: fake.socketPath, delay: noDelay }).events(() => {
    delivered += 1;
    if (delivered === 2) resolveSecond();
    throw new Error("listener bug");
  });
  await second;
  sub.close();
  const settled = connections;
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(connections, settled);
  assert.equal(delivered, 2);
});

test("a failing hello does not stop the stream, and hello is re-read before each connection", async (t) => {
  let hellos = 0;
  const fake = await startFake(t, (req, res) => {
    if (req.url === "/v1/hello") {
      hellos += 1;
      return void res.writeHead(404).end();
    }
    sse(res);
    res.write(frame("1", "disk", { level: "ok", freePct: 50 }));
    res.end();
  });
  const got = collect(2);
  const sub = makeClient({ socketPath: fake.socketPath, delay: noDelay }).events(got.push);
  t.after(() => sub.close());
  await got.reached;
  assert.ok(hellos >= 2);
});
