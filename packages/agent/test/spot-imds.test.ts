import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeClock } from "@dozebox/testkit/fakes";
import { makeImdsSpotNotices } from "../src/spot/imds.ts";

type Step = { readonly status: number; readonly body?: string };

function scripted(steps: Step[]) {
  const calls: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = new Headers(init?.headers);
    calls.push(
      `${init?.method ?? "GET"} ${u.replace("http://imds", "")} ${headers.get("x-aws-ec2-metadata-token") ?? ""}`.trim(),
    );
    const step = steps.shift();
    if (!step) throw new Error(`unscripted request ${u}`);
    return new Response(step.body ?? "", { status: step.status });
  }) as typeof fetch;
  return { f, calls };
}

const NOTICE = { status: 200, body: '{"action":"stop","time":"2026-11-25T10:00:00Z"}' };

test("reads a notice and reuses the token", async () => {
  const { f, calls } = scripted([{ status: 200, body: "tok1" }, NOTICE, { status: 404 }]);
  const spot = makeImdsSpotNotices({ fetch: f, base: "http://imds", clock: makeFakeClock() });
  assert.deepEqual(await spot.instanceAction(), { action: "stop", at: Date.parse("2026-11-25T10:00:00Z") });
  assert.equal(await spot.instanceAction(), null);
  assert.deepEqual(calls, [
    "PUT /latest/api/token",
    "GET /latest/meta-data/spot/instance-action tok1",
    "GET /latest/meta-data/spot/instance-action tok1",
  ]);
});

test("refreshes the token 60 s before its TTL ends", async () => {
  const clock = makeFakeClock();
  const { f, calls } = scripted([
    { status: 200, body: "tok1" },
    { status: 404 },
    { status: 404 },
    { status: 200, body: "tok2" },
    { status: 404 },
  ]);
  const spot = makeImdsSpotNotices({ fetch: f, base: "http://imds", clock });
  await spot.instanceAction();
  clock.advance(21_600_000 - 61_000);
  await spot.instanceAction();
  clock.advance(2_000);
  await spot.instanceAction();
  assert.equal(calls.filter((c) => c.startsWith("PUT")).length, 2);
  assert.ok(calls.at(-1)?.endsWith("tok2"));
});

test("a 401 gets one new token and a retry", async () => {
  const { f, calls } = scripted([{ status: 200, body: "a" }, { status: 401 }, { status: 200, body: "b" }, NOTICE]);
  const spot = makeImdsSpotNotices({ fetch: f, base: "http://imds", clock: makeFakeClock() });
  assert.equal((await spot.instanceAction())?.action, "stop");
  assert.equal(calls.length, 4);
});

test("a second 401 fails", async () => {
  const { f } = scripted([{ status: 200, body: "a" }, { status: 401 }, { status: 200, body: "b" }, { status: 401 }]);
  const spot = makeImdsSpotNotices({ fetch: f, base: "http://imds", clock: makeFakeClock() });
  await assert.rejects(spot.instanceAction(), RunnerError);
});

test("malformed or unexpected answers throw RunnerError", async () => {
  for (const step of [
    { status: 200, body: "not json" },
    { status: 200, body: '{"action":"reboot","time":"2026-11-25T10:00:00Z"}' },
    { status: 200, body: '{"action":"stop","time":"soon"}' },
    { status: 500 },
  ]) {
    const { f } = scripted([{ status: 200, body: "t" }, step]);
    const spot = makeImdsSpotNotices({ fetch: f, base: "http://imds", clock: makeFakeClock() });
    await assert.rejects(spot.instanceAction(), RunnerError);
  }
});
