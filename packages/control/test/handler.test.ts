// The Lambda entry: route by event shape (HTTP, schedule, EC2 event, unknown), lazy deps, and the config check.
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { ConfigError, parseControlConfig } from "../src/config.ts";
import { isEc2Event } from "../src/events/ec2.ts";
import { isScheduleEvent, makeHandler } from "../src/handler.ts";
import { isHttpEvent, type FunctionUrlResult } from "../src/http/event.ts";
import { KEYS } from "../src/state/keys.ts";
import { CONFIG, httpEvent, makeWorld, type World } from "./fixture.ts";

const spotWarning = (id: string, time = "2026-11-25T00:00:30Z") => ({
  version: "0",
  source: "aws.ec2",
  "detail-type": "EC2 Spot Instance Interruption Warning",
  time,
  detail: { "instance-id": id, "instance-action": "stop" },
});
const stateChange = (id: string) => ({
  source: "aws.ec2",
  "detail-type": "EC2 Instance State-change Notification",
  time: "2026-11-25T00:00:30Z",
  detail: { "instance-id": id, state: "stopping" },
});

function handlerOf(w: World) {
  return makeHandler(() => w.deps);
}

describe("event shapes", () => {
  test("classifiers", () => {
    assert.equal(isHttpEvent(httpEvent("GET", "/v1/status")), true);
    assert.equal(isHttpEvent({ rawPath: "/", requestContext: {} }), false);
    assert.equal(isHttpEvent(null), false);
    assert.equal(isScheduleEvent({ dozebox: "reconcile", v: 1 }), true);
    assert.equal(isScheduleEvent({ dozebox: "reconcile", v: 2 }), false);
    assert.equal(isEc2Event(stateChange("i-1")), true);
    assert.equal(isEc2Event({ source: "aws.ec2x" }), false);
  });

  test("HTTP goes to the router", async () => {
    const w = makeWorld();
    const res = await handlerOf(w)(httpEvent("GET", "/v1/status"), { awsRequestId: "req-42" });
    assert.equal((res as FunctionUrlResult).statusCode, 200);
    assert.ok(w.lines.some((l) => l.includes('"requestId":"req-42"')));
  });

  test("the schedule runs one reconcile tick", async () => {
    const w = makeWorld();
    w.aws.ec2.addMachine({ boxId: "main", role: "persistent", state: "stopped", lifecycle: "spot" });
    await w.call("POST", "/v1/wake");
    assert.equal(await handlerOf(w)({ dozebox: "reconcile", v: 1 }), undefined);
    assert.deepEqual(
      w.aws.ec2.calls.map((c) => c.op),
      ["start"],
    );
  });

  test("a Spot warning for the box's machine writes the interruption record and nothing else (R1)", async () => {
    const w = makeWorld();
    const id = w.aws.ec2.addMachine({ boxId: "main", role: "persistent", state: "running", lifecycle: "spot" });
    await handlerOf(w)(spotWarning(id));
    assert.deepEqual(await w.deps.state.get(KEYS.interruption), {
      instanceId: id,
      at: Date.parse("2026-11-25T00:00:30Z"),
    });
    assert.deepEqual(
      w.computeCalls.filter((c) => !c.op.startsWith("describe")),
      [],
    );
    await handlerOf(w)(spotWarning(id, "2026-11-25T00:00:10Z"));
    assert.deepEqual(await w.deps.state.get(KEYS.interruption), {
      instanceId: id,
      at: Date.parse("2026-11-25T00:00:30Z"),
    });
  });

  test("a Spot warning for another box's instance, a group machine, and state changes", async () => {
    const w = makeWorld({ config: { groups: { spot: null, fallback: "dozebox-main-fallback" } } });
    w.aws.asg.addGroup("dozebox-main-fallback", { boxId: "main", lifecycle: "on-demand" });
    await w.aws.asg.compute.setGroupDesired("dozebox-main-fallback", 1, "t");
    const group = await w.aws.asg.compute.describeGroup("dozebox-main-fallback");
    const other = w.aws.ec2.addMachine({ boxId: "other", role: "persistent", state: "running", lifecycle: "spot" });
    const h = handlerOf(w);
    await h(spotWarning(other));
    assert.equal(await w.deps.state.get(KEYS.interruption), null);
    await h(stateChange(other));
    assert.ok(w.lines.some((l) => l.includes('"why":"state-change"')));
    const gid = group.machines[0]?.id ?? "";
    await h(spotWarning(gid));
    assert.equal((await w.deps.state.get(KEYS.interruption)) !== null, true);
  });

  test("an unknown event throws (dead-letter queue)", async () => {
    const w = makeWorld();
    await assert.rejects(handlerOf(w)({ hello: "world" }), /unknown event shape/);
  });
});

describe("deps", () => {
  test("built once, on the first invocation", async () => {
    const w = makeWorld();
    let builds = 0;
    const h = makeHandler(() => {
      builds += 1;
      return w.deps;
    });
    assert.equal(builds, 0);
    await h(httpEvent("GET", "/v1/status"));
    await h(httpEvent("GET", "/v1/status"));
    assert.equal(builds, 1);
  });

  test("a bad DOZEBOX_CONTROL answers HTTP with 500 and throws for other events", async () => {
    const h = makeHandler(() => parseControlConfig(undefined) as never);
    const res = await h(httpEvent("GET", "/v1/status"));
    assert.equal((res as FunctionUrlResult).statusCode, 500);
    await assert.rejects(h({ dozebox: "reconcile", v: 1 }), ConfigError);
  });
});

describe("DOZEBOX_CONTROL", () => {
  const terraformShape = {
    ...CONFIG,
    groups: { spot: null, fallback: "dozebox-main-fallback" },
    caps: { ...CONFIG.caps, maxSpotPricePerHour: null, freezeOnBudget: true, awakeHoursPerDay: null },
    fallback: { enabled: true, unattended: false },
    kill: {
      runbook: "dozebox-main-kill",
      unfreezeRunbook: "dozebox-main-unfreeze",
      roleArn: "arn:aws:iam::111122223333:role/dozebox-main-kill",
      denyPolicyArn: "arn:aws:iam::111122223333:policy/dozebox-main-frozen",
      freezeParameter: "/dozebox/main/freeze",
      alarms: ["dozebox-main-kill-on-demand"],
    },
    http: { tokenHeaders: ["x-legacy-token"] },
  };

  test("the Terraform shape parses; extra keys are allowed", () => {
    const cfg = parseControlConfig(JSON.stringify({ ...terraformShape, later: { key: 1 } }));
    assert.equal(cfg.groups.fallback, "dozebox-main-fallback");
    assert.equal(cfg.caps.awakeHoursPerDay, null);
  });

  test("missing, not JSON, or invalid is a ConfigError naming the field, not the value", () => {
    assert.throws(() => parseControlConfig(undefined), /not set/);
    assert.throws(() => parseControlConfig("{"), /not JSON/);
    assert.throws(
      () => parseControlConfig(JSON.stringify({ ...terraformShape, ssmPrefix: "no-slash-secret" })),
      (e: unknown) =>
        e instanceof ConfigError && e.message.includes("/ssmPrefix") && !e.message.includes("no-slash-secret"),
    );
  });
});
