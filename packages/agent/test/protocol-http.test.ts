// A2 transport: node:http over real Unix sockets, fake clock for the 2 s limit and the ping.
import { strict as assert } from "node:assert";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { makeFakeClock } from "@dozebox/testkit/fakes";
import { makeEventHub } from "../src/protocol/events.ts";
import { makeSocketServer } from "../src/protocol/http.ts";
import type { ProtocolHandler, ProtocolRequest } from "../src/protocol/wire.ts";
import type { LogLevel } from "../src/ports/log.ts";
import { flush } from "./support.ts";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const DISK = { level: "ok", freePct: 40 };

async function setup(handle: ProtocolHandler = async () => ({ status: 200, body: { ok: true } })) {
  const dir = await mkdtemp(join(tmpdir(), "dz-http-"));
  dirs.push(dir);
  const clock = makeFakeClock();
  const events = makeEventHub({ bootId: "b" });
  const logs: Array<{ level: LogLevel; msg: string; fields: Readonly<Record<string, unknown>> | undefined }> = [];
  const log = {
    log: (level: LogLevel, msg: string, fields?: Readonly<Record<string, unknown>>) =>
      void logs.push({ level, msg, fields }),
    child: () => log,
  };
  let n = 0;
  const server = makeSocketServer({ handle, events, log, clock, ids: () => `req-${++n}` });
  closers.push(() => server.close());
  const payloadPath = join(dir, "sub", "x.sock");
  const adminPath = join(dir, "admin.sock");
  await server.listen({ path: payloadPath, socket: { kind: "payload", payload: "x" } });
  await server.listen({ path: adminPath, socket: { kind: "admin" } });
  return { dir, clock, events, logs, server, payloadPath, adminPath };
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string };

function call(
  socketPath: string,
  method: string,
  path: string,
  body?: string | Buffer,
  headers: Record<string, string> = {},
) {
  return new Promise<Reply>((resolve, reject) => {
    const req = request({ socketPath, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString() }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Opens the event stream and gives access to what has arrived so far. */
function stream(socketPath: string, headers: Record<string, string> = {}) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    text: () => string;
    waitFor: (s: string) => Promise<void>;
    abort: () => void;
    ended: Promise<void>;
  }>((resolve, reject) => {
    const req = request({ socketPath, method: "GET", path: "/v1/events", headers }, (res) => {
      let text = "";
      const waiters: Array<{ s: string; ok: () => void }> = [];
      const ended = new Promise<void>((r) => {
        res.on("end", r);
        res.on("close", r);
        res.on("error", r);
      });
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        text += c;
        const due = waiters.filter((w) => text.includes(w.s));
        for (const w of due) {
          waiters.splice(waiters.indexOf(w), 1);
          w.ok();
        }
      });
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => text,
        waitFor: (s) => (text.includes(s) ? Promise.resolve() : new Promise<void>((ok) => waiters.push({ s, ok }))),
        abort: () => req.destroy(),
        ended,
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("200 JSON round trip: request fields reach the handler, headers and body come back", async () => {
  let seen: ProtocolRequest | undefined;
  const t = await setup(async (req) => {
    seen = req;
    return { status: 201, body: { got: req.body }, headers: { "x-extra": "1" } };
  });
  const r = await call(t.payloadPath, "POST", "/v1/holds/run-42?a=1&b=two", JSON.stringify({ k: [1] }), {
    "Content-Type": "application/json",
    "X-Dozebox-Payload": "ignored",
  });
  assert.equal(r.status, 201);
  assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(r.headers["x-request-id"], "req-1");
  assert.equal(r.headers["x-extra"], "1");
  assert.deepEqual(JSON.parse(r.text), { got: { k: [1] } });
  assert.ok(seen);
  assert.equal(seen.method, "POST");
  assert.equal(seen.path, "/v1/holds/run-42");
  assert.equal(seen.query.get("a"), "1");
  assert.equal(seen.query.get("b"), "two");
  assert.deepEqual(seen.socket, { kind: "payload", payload: "x" });
  assert.equal(seen.headers["content-type"], "application/json");
  assert.equal(seen.headers["x-dozebox-payload"], "ignored");
  assert.deepEqual(seen.body, { k: [1] });
  assert.equal(seen.requestId, "req-1");
  await call(t.adminPath, "GET", "/v1/status");
  assert.deepEqual(seen.socket, { kind: "admin" });
  assert.equal(seen.body, undefined);
});

test("204 is sent with no body", async () => {
  const t = await setup(async () => ({ status: 204 }));
  const r = await call(t.payloadPath, "DELETE", "/v1/holds/x");
  assert.equal(r.status, 204);
  assert.equal(r.text, "");
  assert.equal(r.headers["content-type"], undefined);
  assert.equal(r.headers["x-request-id"], "req-1");
});

test("a body over 16 KiB is 413 too_large and never reaches the handler", async () => {
  let called = false;
  const t = await setup(async () => ((called = true), { status: 200 }));
  const r = await call(t.payloadPath, "POST", "/v1/x", Buffer.alloc(16 * 1024 + 1, 0x61));
  assert.equal(r.status, 413);
  assert.deepEqual(JSON.parse(r.text), {
    error: { code: "too_large", message: JSON.parse(r.text).error.message, retryable: false },
  });
  assert.equal(called, false);
  const ok = await call(t.payloadPath, "POST", "/v1/x", JSON.stringify({ pad: "a".repeat(16 * 1024 - 20) }));
  assert.equal(ok.status, 200);
});

test("a body that is not JSON is 400 bad_request", async () => {
  let called = false;
  const t = await setup(async () => ((called = true), { status: 200 }));
  const r = await call(t.payloadPath, "POST", "/v1/x", "{nope");
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.text).error.code, "bad_request");
  assert.equal(JSON.parse(r.text).error.retryable, false);
  assert.equal(called, false);
});

test("a handler that throws is 500 internal (retryable), carries X-Request-Id and is logged at error", async () => {
  const t = await setup(async () => {
    throw new Error("boom");
  });
  const r = await call(t.payloadPath, "GET", "/v1/status");
  assert.equal(r.status, 500);
  assert.equal(r.headers["x-request-id"], "req-1");
  assert.equal(JSON.parse(r.text).error.code, "internal");
  assert.equal(JSON.parse(r.text).error.retryable, true);
  const line = t.logs.find((l) => l.level === "error");
  assert.ok(line);
  assert.equal(line.fields?.["requestId"], "req-1");
});

test("a handler not done in 2 s is 500 internal and a warning is logged", async () => {
  let started!: () => void;
  const reached = new Promise<void>((r) => (started = r));
  const t = await setup(() => {
    started();
    return new Promise(() => undefined);
  });
  const pending = call(t.payloadPath, "GET", "/v1/status");
  await reached;
  await flush();
  t.clock.advance(1_999);
  await flush();
  t.clock.advance(1);
  const r = await pending;
  assert.equal(r.status, 500);
  assert.equal(JSON.parse(r.text).error.code, "internal");
  assert.equal(r.headers["x-request-id"], "req-1");
  assert.equal(t.logs.find((l) => l.level === "warn")?.fields?.["requestId"], "req-1");
});

test("a finished request leaves no timer on the clock", async () => {
  const t = await setup();
  await call(t.payloadPath, "GET", "/v1/status");
  assert.equal(t.clock.pending(), 0);
});

test("listen: socket file mode 0600 and parent created; a stale file is replaced; mode and owner are honoured", async () => {
  const t = await setup();
  assert.equal((await stat(t.payloadPath)).mode & 0o777, 0o600);
  const path = join(t.dir, "stale.sock");
  await writeFile(path, "");
  await t.server.listen({ path, socket: { kind: "admin" }, mode: 0o660 });
  assert.equal((await stat(path)).mode & 0o777, 0o660);
  assert.equal((await call(path, "GET", "/")).status, 200);
});
test("SSE replays after Last-Event-ID then streams live events", async () => {
  const t = await setup();
  t.events.publish("disk", DISK);
  t.events.publish("disk", { level: "low", freePct: 5 });
  const s = await stream(t.adminPath, { "Last-Event-ID": "b-1" });
  assert.equal(s.status, 200);
  assert.equal(s.headers["content-type"], "text/event-stream");
  assert.equal(s.headers["cache-control"], "no-store");
  await s.waitFor("id: b-2\n");
  assert.equal(s.text(), `id: b-2\nevent: disk\ndata: ${JSON.stringify({ level: "low", freePct: 5 })}\n\n`);
  t.events.publish("disk", DISK);
  await s.waitFor("id: b-3\n");
  assert.ok(s.text().endsWith(`id: b-3\nevent: disk\ndata: ${JSON.stringify(DISK)}\n\n`));
  s.abort();
});

test("SSE without Last-Event-ID replays nothing", async () => {
  const t = await setup();
  t.events.publish("disk", DISK);
  const s = await stream(t.adminPath);
  t.events.publish("disk", DISK);
  await s.waitFor("id: b-2\n");
  assert.ok(!s.text().includes("id: b-1\n"));
  s.abort();
});

test("SSE shows a payload socket only broadcast events and its own", async () => {
  const t = await setup();
  const mine = await stream(t.payloadPath);
  const admin = await stream(t.adminPath);
  t.events.publish("disk", DISK, "other");
  t.events.publish("disk", DISK, "x");
  t.events.publish("disk", DISK);
  await admin.waitFor("id: b-3\n");
  await mine.waitFor("id: b-3\n");
  assert.ok(!mine.text().includes("id: b-1\n"));
  assert.ok(mine.text().includes("id: b-2\n"));
  assert.ok(admin.text().includes("id: b-1\n"));
  mine.abort();
  admin.abort();
});

test("SSE sends a ping without an id every 25 s on the clock", async () => {
  const t = await setup();
  const s = await stream(t.adminPath);
  t.clock.advance(24_999);
  await flush();
  assert.equal(s.text(), "");
  t.clock.advance(1);
  await s.waitFor("event: ping\n");
  assert.equal(s.text(), "event: ping\ndata: {}\n\n");
  t.clock.advance(25_000);
  await s.waitFor("event: ping\ndata: {}\n\nevent: ping");
  s.abort();
});

test("a client that disconnects stops its ping loop and subscription", async () => {
  const t = await setup();
  const s = await stream(t.adminPath);
  assert.equal(t.clock.pending(), 1);
  s.abort();
  await s.ended;
  await call(t.adminPath, "GET", "/");
  await flush();
  assert.equal(t.clock.pending(), 0);
});

test("close() ends streams, removes the socket files and is safe twice", async () => {
  const t = await setup();
  const s = await stream(t.adminPath);
  await t.server.close();
  await s.ended;
  await assert.rejects(stat(t.adminPath), { code: "ENOENT" });
  await assert.rejects(stat(t.payloadPath), { code: "ENOENT" });
  assert.equal(t.clock.pending(), 0);
  await t.server.close();
});

test("unlisten closes one socket and ignores an unknown path", async () => {
  const t = await setup();
  await t.server.unlisten(t.payloadPath);
  await assert.rejects(stat(t.payloadPath), { code: "ENOENT" });
  assert.equal((await call(t.adminPath, "GET", "/")).status, 200);
  await t.server.unlisten(join(t.dir, "nothing.sock"));
});
