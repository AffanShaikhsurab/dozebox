// C2 outbox: enqueue before delivery; a crash between the write and the delivery delivers exactly once on the next
// tick; backoff 1, 2, 4, 8, 15 min with jitter; `failed` 24 h after the alert; a stale token cannot write.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeAws } from "@dozebox/testkit/fakes";
import { makeOutbox, nextAttempt, type Outbox } from "../src/alerts/outbox.ts";
import type { Alert } from "../src/ports/alertSink.ts";

const MIN = 60_000;

function world() {
  const aws = makeFakeAws();
  const outbox = makeOutbox({ state: aws.dynamodb.table, clock: aws.clock, rand: () => 0.5 });
  const alert: Alert = {
    id: "a1",
    key: "box-silent",
    severity: "page",
    title: "Box silent",
    body: "No liveness for 10 min.",
    source: "runner:judge",
    at: aws.clock.now(),
  };
  return { aws, outbox, alert };
}

/** One tick's drain: deliver every due item through `send`, then mark it. */
async function drain(outbox: Outbox, now: number, send: (sink: string) => boolean, token: number) {
  for (const item of await outbox.due(now)) {
    if (send(item.sink)) await outbox.markSent(item, token);
    else await outbox.markAttempt(item, "down", token);
  }
}

describe("nextAttempt", () => {
  test("1, 2, 4, 8 min, then 15 min, +-20% jitter", () => {
    const mid = [0, 1, 2, 3, 4, 9].map((a) => nextAttempt(a, 0, () => 0.5));
    assert.deepEqual(
      mid,
      [1, 2, 4, 8, 15, 15].map((m) => m * MIN),
    );
    assert.equal(
      nextAttempt(0, 1_000, () => 0),
      1_000 + 0.8 * MIN,
    );
    assert.equal(
      nextAttempt(0, 1_000, () => 1),
      1_000 + 1.2 * MIN,
    );
  });
});

describe("outbox", () => {
  test("enqueue writes one pending item per sink, due now; a re-enqueue changes nothing", async () => {
    const { aws, outbox, alert } = world();
    await outbox.enqueue(alert, ["ntfy", "email", "ntfy"], 1);
    const due = await outbox.due(aws.clock.now());
    assert.deepEqual(
      due.map((i) => [i.sink, i.status, i.attempts]),
      [
        ["ntfy", "pending", 0],
        ["email", "pending", 0],
      ],
    );
    await outbox.markSent(due[0]!, 1);
    await outbox.enqueue(alert, ["ntfy", "email"], 1);
    assert.deepEqual(
      (await outbox.due(aws.clock.now())).map((i) => i.sink),
      ["email"],
    );
  });

  test("a crash between the write and the delivery delivers exactly once on the next tick", async () => {
    const { aws, outbox, alert } = world();
    await outbox.enqueue(alert, ["ntfy"], 1); // then the function dies before delivering
    const sent: string[] = [];
    aws.clock.advance(MIN);
    await drain(outbox, aws.clock.now(), (s) => sent.push(s) > 0, 2);
    aws.clock.advance(MIN);
    await drain(outbox, aws.clock.now(), (s) => sent.push(s) > 0, 3);
    assert.deepEqual(sent, ["ntfy"]);
  });

  test("a failed delivery is retried with backoff and fails for good 24 h after the alert", async () => {
    const { aws, outbox, alert } = world();
    await outbox.enqueue(alert, ["ntfy"], 1);
    const [item] = await outbox.due(aws.clock.now());
    const next = await outbox.markAttempt(item!, "503", 1);
    assert.deepEqual([next.status, next.attempts, next.nextAttemptAt], ["pending", 1, aws.clock.now() + MIN]);
    assert.deepEqual(await outbox.due(aws.clock.now()), []);
    aws.clock.advance(24 * 60 * MIN);
    const [late] = await outbox.due(aws.clock.now());
    const done = await outbox.markAttempt(late!, "503", 1);
    assert.equal(done.status, "failed");
    assert.deepEqual(await outbox.due(aws.clock.now() + 60 * MIN), []);
  });

  test("marking an item another drain already settled keeps the stored state", async () => {
    const { aws, outbox, alert } = world();
    await outbox.enqueue(alert, ["ntfy"], 1);
    const [item] = await outbox.due(aws.clock.now());
    await outbox.markSent(item!, 1);
    const after = await outbox.markAttempt(item!, "late", 1);
    assert.equal(after.status, "sent");
  });

  test("a stale token cannot write the outbox", async () => {
    const { outbox, alert } = world();
    await outbox.enqueue(alert, ["ntfy"], 5);
    await assert.rejects(
      outbox.enqueue({ ...alert, id: "a2" }, ["ntfy"], 4),
      (e: unknown) => e instanceof RunnerError && e.code === "lease_lost",
    );
  });
});
