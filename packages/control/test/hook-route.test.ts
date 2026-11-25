// /v1/hooks/github through the router: the signature is the authentication (no wake token), a matching event writes
// desired = awake with origin event and calls no Compute action, a bad signature is 401 and writes nothing.
import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { makeFakeSecretReader } from "@dozebox/testkit/fakes";
import { makeWorld } from "./fixture.ts";

const SECRET = "hook-secret-0123456789";
const writer = { instanceId: "i-0123456789abcdef0", bootId: "boot-0001" };

async function world() {
  const w = makeWorld({
    config: { hooks: { github: { secret: "github-hook" } } },
    secrets: makeFakeSecretReader({ "github-hook": SECRET }),
  });
  const at = new Date(w.aws.clock.now()).toISOString();
  const later = new Date(w.aws.clock.now() + 3_600_000).toISOString();
  const wakes = {
    v: 1,
    at,
    writer,
    atPark: true,
    wakes: [
      {
        payload: "app",
        id: "pr-7",
        reason: "review",
        at,
        expiresAt: later,
        on: { source: "github", repository: "acme/app", events: ["pull_request"], number: 7 },
      },
    ],
  };
  await w.deps.records.put("rec/wakes", JSON.stringify(wakes), { tier: "Standard" });
  return w;
}

const event = JSON.stringify({ action: "opened", number: 7, repository: { full_name: "acme/app" } });
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const headers = (sig: string, delivery = "d-1") => ({
  "x-hub-signature-256": sig,
  "x-github-event": "pull_request",
  "x-github-delivery": delivery,
});

test("a signed matching GitHub event wakes the box (origin event) without the wake token", async () => {
  const w = await world();
  const res = await w.call("POST", "/v1/hooks/github", { token: null, body: event, headers: headers(sign(event)) });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json, { v: 1, wake: true, why: "github:pull_request" });
  const d = await w.deps.desired.read();
  assert.deepEqual([d.want, d.origin], ["awake", "event"]);
  const again = await w.call("POST", "/v1/hooks/github", { token: null, body: event, headers: headers(sign(event)) });
  assert.deepEqual(again.json, { v: 1, wake: false, why: "duplicate" });
  assert.deepEqual(
    w.computeCalls.filter((c) => !c.op.startsWith("describe")),
    [],
  );
});

test("a bad signature is 401 and writes nothing", async () => {
  const w = await world();
  const res = await w.call("POST", "/v1/hooks/github", {
    token: null,
    body: event,
    headers: headers(sign(event, "x")),
  });
  assert.equal(res.statusCode, 401);
  assert.equal((await w.deps.desired.read()).want, "asleep");
});
