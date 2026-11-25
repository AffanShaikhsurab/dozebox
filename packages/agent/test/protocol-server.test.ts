// The protocol server end to end: real Unix sockets in a temp dir, the real store and routes, a fake clock.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeFakeClock, makeFakeFs, makeFakePresenceSource } from "@dozebox/testkit/fakes";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";
import { makeJsonLogger } from "../src/adapters/log.ts";
import { makeProtocolServer, socketPath } from "../src/protocol/server.ts";
import { makeProtocolStore } from "../src/protocol/store.ts";
/** Real socket I/O needs event-loop turns, not time: wait until `check` passes, at most `max` turns. */
async function turnsUntil(check: () => Promise<boolean>, max = 500): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await check()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  assert.fail("condition not reached");
}
const gone = (path: string) => () =>
  stat(path).then(
    () => false,
    () => true,
  );

type Answer = { readonly status: number; readonly body: unknown };

function call(
  path: string,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { socketPath: path, method, path: url, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data === "" ? undefined : JSON.parse(data) }));
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "dz-proto-"));
  const clock = makeFakeClock();
  const files = makeNodeFiles(makeFakeFs().fs.promises as unknown as FsPromises, 1);
  const store = await makeProtocolStore({ files, path: "/data/dozebox/protocol.json", bootId: "boot-1" });
  const payloads = ["web", "api"];
  const source = makeFakePresenceSource("ssh");
  const lines: string[] = [];
  const server = makeProtocolServer({
    store,
    log: makeJsonLogger((l) => lines.push(l), clock.now),
    now: clock.now,
    clock,
    bootId: "boot-1",
    boxId: "box-1",
    agentVersion: "1.0.0",
    payloads: () => payloads,
    status: () => {
      throw new Error("status not used here");
    },
    presenceSources: [source],
    sleep: async () => ({ accepted: true, blockers: [] }),
    attention: async () => "alert-1",
    socketDir: dir,
  });
  const done = async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, clock, store, server, payloads, source, done };
}

describe("protocol server over sockets", () => {
  it("serves each payload on its own 0600 socket and the admin socket", async () => {
    const t = await setup();
    try {
      await t.server.start();
      const web = await call(socketPath("web", t.dir), "GET", "/v1/hello");
      assert.equal(web.status, 200);
      assert.deepEqual((web.body as { payload: unknown }).payload, { name: "web" });
      const api = await call(socketPath("api", t.dir), "GET", "/v1/hello");
      assert.deepEqual((api.body as { payload: unknown }).payload, { name: "api" });
      assert.equal((await stat(socketPath("web", t.dir))).mode & 0o777, 0o600);
      assert.equal((await stat(join(t.dir, "admin.sock"))).mode & 0o777, 0o600);
      const put = await call(
        join(t.dir, "admin.sock"),
        "PUT",
        "/v1/holds/job",
        { reason: "r", until: new Date(t.clock.now() + 60_000).toISOString() },
        { "x-dozebox-payload": "api" },
      );
      assert.equal(put.status, 200);
      assert.deepEqual(
        (await t.store.holds(t.clock.now())).map((h) => h.key),
        ["api/job"],
      );
    } finally {
      await t.done();
    }
  });

  it("the caller is the socket: a hold put on web's socket is web's", async () => {
    const t = await setup();
    try {
      await t.server.start();
      const until = new Date(t.clock.now() + 60_000).toISOString();
      assert.equal((await call(socketPath("web", t.dir), "PUT", "/v1/holds/ci", { reason: "r", until })).status, 200);
      const list = await call(socketPath("api", t.dir), "GET", "/v1/holds");
      assert.deepEqual(list.body, { holds: [] });
    } finally {
      await t.done();
    }
  });

  it("samples presence sources every 30 s and follows the payload list", async () => {
    const t = await setup();
    try {
      t.source.samples = [{ id: "src:ssh", kind: "interactive", until: t.clock.now() + 120_000 }];
      await t.server.start();
      await turnsUntil(async () => (await t.store.presence(t.clock.now())).length === 1);
      assert.deepEqual(
        (await t.store.presence(t.clock.now())).map((p) => p.key),
        ["src:ssh"],
      );
      t.payloads.splice(1, 1);
      await turnsUntil(async () => {
        t.clock.advance(30_000);
        return gone(socketPath("api", t.dir))();
      });
    } finally {
      await t.done();
    }
  });

  it("stop removes the socket files", async () => {
    const t = await setup();
    await t.server.start();
    await t.server.stop();
    await assert.rejects(stat(socketPath("web", t.dir)), /ENOENT/);
    await assert.rejects(stat(join(t.dir, "admin.sock")), /ENOENT/);
    await rm(t.dir, { recursive: true, force: true });
  });
});
