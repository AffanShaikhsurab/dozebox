import { strict as assert } from "node:assert";
import { test } from "node:test";
import { IMDS_TOKEN_HEADER, IMDS_TTL_HEADER, startFakeImds, type FakeImds } from "../src/fakes/imds.ts";

async function token(imds: FakeImds): Promise<string> {
  const res = await fetch(`${imds.base}/latest/api/token`, { method: "PUT", headers: { [IMDS_TTL_HEADER]: "60" } });
  assert.equal(res.status, 200);
  return res.text();
}

const get = (imds: FakeImds, path: string, t?: string): Promise<Response> =>
  fetch(`${imds.base}${path}`, { headers: t ? { [IMDS_TOKEN_HEADER]: t } : {} });

test("FakeImds refuses a metadata read without the X-aws-ec2-metadata-token header", async (t) => {
  const imds = await startFakeImds();
  t.after(() => imds.close());
  assert.equal((await get(imds, "/latest/meta-data/instance-id")).status, 401);
  assert.equal((await get(imds, "/latest/meta-data/instance-id", "made-up")).status, 401);
});

test("FakeImds listens on loopback only and serves identity with a token", async (t) => {
  const imds = await startFakeImds({ instanceId: "i-0bbbbbbbbbbbbbbbb", availabilityZone: "us-east-1c" });
  t.after(() => imds.close());
  assert.match(imds.base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const tk = await token(imds);
  assert.equal(await (await get(imds, "/latest/meta-data/instance-id", tk)).text(), "i-0bbbbbbbbbbbbbbbb");
  assert.equal(await (await get(imds, "/latest/meta-data/placement/availability-zone", tk)).text(), "us-east-1c");
  assert.equal(await (await get(imds, "/latest/meta-data/instance-life-cycle", tk)).text(), "spot");
});

test("FakeImds: the token PUT needs a TTL header", async (t) => {
  const imds = await startFakeImds();
  t.after(() => imds.close());
  assert.equal((await fetch(`${imds.base}/latest/api/token`, { method: "PUT" })).status, 400);
});

test("FakeImds: spot/instance-action is 404 until a notice is set", async (t) => {
  const imds = await startFakeImds();
  t.after(() => imds.close());
  const tk = await token(imds);
  assert.equal((await get(imds, "/latest/meta-data/spot/instance-action", tk)).status, 404);
  imds.setSpotAction({ action: "stop", time: "2026-11-25T03:02:00Z" });
  const res = await get(imds, "/latest/meta-data/spot/instance-action", tk);
  assert.deepEqual(await res.json(), { action: "stop", time: "2026-11-25T03:02:00Z" });
  imds.setSpotAction(null);
  assert.equal((await get(imds, "/latest/meta-data/spot/instance-action", tk)).status, 404);
});

test("FakeImds: expired tokens and one-shot faults", async (t) => {
  const imds = await startFakeImds();
  t.after(() => imds.close());
  const tk = await token(imds);
  imds.failNext(500);
  assert.equal((await get(imds, "/latest/meta-data/instance-id", tk)).status, 500);
  assert.equal((await get(imds, "/latest/meta-data/instance-id", tk)).status, 200);
  imds.expireTokens();
  assert.equal((await get(imds, "/latest/meta-data/instance-id", tk)).status, 401);
  assert.equal(imds.requests.at(-1)?.token, tk);
});
