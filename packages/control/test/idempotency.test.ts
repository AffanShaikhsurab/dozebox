// C2 idempotency: the first answer for a key is kept for 24 h; scopes do not mix; action tokens are stable, never a
// clock value; an idempotent wake returns the same response for the same key through the default deps.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { makeFakeAws } from "@dozebox/testkit/fakes";
import { actionToken, IDEMPOTENCY_TTL_SECONDS, makeStateIdempotency } from "../src/state/idempotency.ts";
import { body, makeWorld } from "./fixture.ts";

describe("idempotency keys", () => {
  test("remember keeps the first answer; recall returns it until the TTL passes", async () => {
    const aws = makeFakeAws();
    const idem = makeStateIdempotency<{ readonly n: number }>(aws.dynamodb.table, "wake");
    assert.equal(await idem.recall("k"), null);
    await idem.remember("k", { n: 1 });
    await idem.remember("k", { n: 2 });
    assert.deepEqual(await idem.recall("k"), { n: 1 });
    assert.equal(await makeStateIdempotency(aws.dynamodb.table, "hook:github").recall("k"), null);
    aws.clock.advance(IDEMPOTENCY_TTL_SECONDS * 1000 + 1_000);
    assert.equal(await idem.recall("k"), null);
  });

  test("actionToken: 64 hex characters, stable, different per box, intent and attempt", () => {
    const t = actionToken("main", "3456", 0);
    assert.match(t, /^[0-9a-f]{64}$/);
    assert.equal(actionToken("main", "3456", 0), t);
    const others = [actionToken("other", "3456", 0), actionToken("main", "3457", 0), actionToken("main", "3456", 1)];
    assert.equal(new Set([t, ...others]).size, 4);
  });

  test("a repeated wake with the same Idempotency-Key returns the same answer and does nothing", async () => {
    const w = makeWorld();
    const first = await w.call("POST", "/v1/wake", { headers: { "idempotency-key": "run-1" } });
    assert.equal(first.statusCode, 202);
    await w.call("POST", "/v1/park");
    w.aws.clock.advance(1_000);
    const again = await w.call("POST", "/v1/wake", { headers: { "idempotency-key": "run-1" } });
    assert.equal(again.statusCode, 202);
    assert.equal(again.body, first.body);
    assert.equal((await w.deps.desired.read()).want, "asleep", "the repeat wrote nothing");
    assert.equal((await w.deps.wakeLedger.read(w.aws.clock.now())).length, 1);
    const other = await w.call("POST", "/v1/wake", { headers: { "idempotency-key": "run-2" } });
    assert.equal(body(other).decision, "accept");
  });
});
