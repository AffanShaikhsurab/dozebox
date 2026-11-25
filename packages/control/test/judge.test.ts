// C6 outside judge: R3 wake failure after 15 min (page once, breaker counts, a serve resets it), silent box (page
// once per serving period), no-progress park (desired asleep, origin judge), nothing while asleep.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { type WakeBreaker } from "@dozebox/core/wake";
import { makeFakeAws } from "@dozebox/testkit/fakes";
import { makeOutsideJudge, NO_MARKS, type JudgeMarks } from "../src/judge/outside.ts";
import type { Alert } from "../src/ports/alertSink.ts";
import { makeDesiredStore } from "../src/state/desired.ts";

const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const writer = { instanceId: "i-0123456789abcdef0", bootId: "boot-0001" };

function world(noProgressParkMs = 60 * MIN) {
  const aws = makeFakeAws();
  const records = aws.ssm.store("/dozebox/main/");
  const desired = makeDesiredStore(aws.dynamodb.table);
  let breaker: WakeBreaker | null = null;
  let marks: JudgeMarks = NO_MARKS;
  const sent: Alert[] = [];
  const judge = makeOutsideJudge({
    clock: aws.clock,
    records,
    desired,
    breaker: { read: async () => breaker, write: async (b) => void (breaker = b) },
    marks: { read: async () => marks, write: async (m) => void (marks = m) },
    alerts: { submit: async (a) => void sent.push(a) },
    noProgressParkMs,
  });
  const put = (name: string, v: unknown) => records.put(name, JSON.stringify(v), { tier: "Advanced" });
  const serve = (t: number) => put("rec/serving", { v: 1, at: iso(t), writer, payload: "example" });
  const live = (t: number, o: { progressAt?: number; work?: number } = {}) =>
    put("rec/liveness", {
      v: 1,
      at: iso(t),
      writer,
      agent: { version: "1.0.0", ok: true, strikes: 0 },
      payloads: [
        {
          name: "example",
          health: "ok",
          restartsThisHour: 0,
          lastProgressAt: o.progressAt === undefined ? null : iso(o.progressAt),
          progress: {},
          holds: { work: o.work ?? 0, wait: 0, until: null, reasons: [] },
        },
      ],
      presence: { interactiveUntil: null, lastInteractiveAt: null },
      idle: { since: null, sleepAt: null },
      net: { ok: true, downSince: null },
      disk: { level: "ok", freePct: 50 },
      undelivered: [],
    });
  const wake = () => desired.write({ want: "awake", since: aws.clock.now(), reason: "wake:person", origin: "user" });
  return { aws, judge, desired, sent, serve, live, wake, breaker: () => breaker };
}

describe("outside judge", () => {
  test("R3: a wake not serving after 15 min pages once and counts on the wake breaker", async () => {
    const w = world();
    await w.wake();
    w.aws.clock.advance(14 * MIN);
    assert.deepEqual(await w.judge.run(1), { kind: "ok" });
    w.aws.clock.advance(MIN);
    assert.equal((await w.judge.run(1)).kind, "wake-unresolved");
    w.aws.clock.advance(MIN);
    await w.judge.run(1);
    assert.deepEqual(
      w.sent.map((a) => [a.key, a.severity]),
      [["wake-unresolved", "page"]],
    );
    assert.equal(w.breaker()?.failuresInRow, 1);
  });

  test("a wake that served resets the breaker; a serve from before the wake does not count", async () => {
    const w = world();
    await w.serve(w.aws.clock.now());
    w.aws.clock.advance(MIN);
    await w.wake();
    w.aws.clock.advance(16 * MIN);
    assert.equal((await w.judge.run(1)).kind, "wake-unresolved");
    await w.serve(w.aws.clock.now());
    await w.live(w.aws.clock.now(), { work: 1 });
    assert.deepEqual(await w.judge.run(1), { kind: "ok" });
    assert.equal(w.breaker()?.failuresInRow, 0);
  });

  test("a serving box silent for 12 min pages once per serving period", async () => {
    const w = world();
    await w.wake();
    await w.serve(w.aws.clock.now());
    await w.live(w.aws.clock.now(), { work: 1 });
    w.aws.clock.advance(12 * MIN);
    assert.equal((await w.judge.run(1)).kind, "silent");
    w.aws.clock.advance(MIN);
    assert.equal((await w.judge.run(1)).kind, "silent");
    assert.deepEqual(
      w.sent.map((a) => a.key),
      ["box-silent"],
    );
  });

  test("no progress for noProgressParkMs parks with origin judge; a work hold keeps it awake", async () => {
    const w = world(30 * MIN);
    await w.wake();
    const t0 = w.aws.clock.now();
    await w.serve(t0);
    w.aws.clock.advance(31 * MIN);
    await w.live(w.aws.clock.now(), { progressAt: t0, work: 1 });
    assert.deepEqual(await w.judge.run(1), { kind: "ok" });
    await w.live(w.aws.clock.now(), { progressAt: t0 });
    assert.equal((await w.judge.run(1)).kind, "no-progress-park");
    const d = await w.desired.read();
    assert.deepEqual([d.want, d.reason, d.origin], ["asleep", "park:no-progress", "judge"]);
  });

  test("nothing is judged while desired is asleep", async () => {
    const w = world();
    w.aws.clock.advance(60 * MIN);
    assert.deepEqual(await w.judge.run(1), { kind: "ok" });
    assert.deepEqual(w.sent, []);
  });
});
