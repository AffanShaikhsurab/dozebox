// The SSM record store on a stubbed SDK client: the recordStore contract offline, then the request shapes.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SSMClient } from "@aws-sdk/client-ssm";
import { recordStoreContract, rejectsWith } from "@dozebox/testkit/contracts";
import { offlineConfig, ssmMemory } from "@dozebox/testkit/wire";
import { makeAwsRecordStore } from "../src/adapters/aws/ssm.ts";

const ROOT = "/dozebox/box-1/";

function setup() {
  const ssm = new SSMClient(offlineConfig);
  const mem = ssmMemory(ssm, () => 1_700_000_000_000);
  return { mem, store: makeAwsRecordStore({ ssm, root: ROOT }) };
}

recordStoreContract("aws ssm adapter (stubbed client)", async () => {
  const { mem, store } = setup();
  return {
    writer: store,
    reader: store,
    calls: () => mem.stub.calls.length,
    inject: (op, name, status) =>
      mem.stub.fail(op === "put" ? "PutParameterCommand" : "GetParameterCommand", name, status),
  };
});

test("put sends a String parameter under the root with the record's tier and Overwrite", async () => {
  const { mem, store } = setup();
  await store.put("rec/liveness", "{}", { tier: "Advanced" });
  await store.put("ctl/desired", "{}", { tier: "Standard" });
  assert.deepEqual(mem.stub.inputs("PutParameterCommand"), [
    { Name: "/dozebox/box-1/rec/liveness", Value: "{}", Type: "String", Tier: "Advanced", Overwrite: true },
    { Name: "/dozebox/box-1/ctl/desired", Value: "{}", Type: "String", Tier: "Standard", Overwrite: true },
  ]);
});

test("a Standard write over an Advanced parameter is repeated once as Advanced", async () => {
  const { mem, store } = setup();
  await store.put("rec/serving", "x".repeat(5000), { tier: "Advanced" });
  await store.put("rec/serving", "small", { tier: "Standard" });
  assert.deepEqual(
    mem.stub.inputs("PutParameterCommand").map((i) => i["Tier"]),
    ["Advanced", "Standard", "Advanced"],
  );
  assert.equal(mem.parameters.get("/dozebox/box-1/rec/serving")?.value, "small");
});

test("any other ValidationException on put is not retried", async () => {
  const { mem, store } = setup();
  mem.stub.fail("PutParameterCommand", "ValidationException", 400, "something else");
  await rejectsWith(store.put("rec/serving", "x", { tier: "Standard" }), "invalid_input", false);
  assert.equal(mem.stub.inputs("PutParameterCommand").length, 1);
});

test("the Advanced retry's own failure is mapped", async () => {
  const { mem, store } = setup();
  mem.stub.fail("PutParameterCommand", "ValidationException", 400, "You can't downgrade a parameter");
  mem.stub.fail("PutParameterCommand", "ThrottlingException", 400);
  await rejectsWith(store.put("rec/serving", "x", { tier: "Standard" }), "aws_throttled", true);
  assert.equal(mem.stub.inputs("PutParameterCommand").length, 2);
});

test("readAll pages by path without the trailing slash, recursively, 10 at a time; SecureString skipped", async () => {
  const { mem, store } = setup();
  for (let i = 0; i < 23; i++) await store.put(`rec/r${String(i).padStart(2, "0")}`, `v${i}`, { tier: "Standard" });
  mem.parameters.set("/dozebox/box-1/wake-token", {
    value: "ciphertext",
    type: "SecureString",
    tier: "Standard",
    modifiedAt: 0,
  });
  mem.parameters.set("/dozebox/box-10/rec/other", { value: "no", type: "String", tier: "Standard", modifiedAt: 0 });
  const all = await store.readAll();
  assert.equal(all.length, 23);
  assert.equal(all[0]?.name, "rec/r00");
  assert.equal(all[0]?.modifiedAt, 1_700_000_000_000);
  const pages = mem.stub.inputs("GetParametersByPathCommand");
  assert.equal(pages.length, 3);
  assert.deepEqual(pages[0], { Path: "/dozebox/box-1", Recursive: true, MaxResults: 10 });
  assert.equal(pages[1]?.["NextToken"], "10");
});

test("readAll maps a throttle", async () => {
  const { mem, store } = setup();
  mem.stub.fail("GetParametersByPathCommand", "ThrottlingException", 400);
  await rejectsWith(store.readAll(), "aws_throttled", true);
});

test("delete maps errors other than not-found; get and delete check the name first", async () => {
  const { mem, store } = setup();
  mem.stub.fail("DeleteParameterCommand", "AccessDeniedException", 400);
  await rejectsWith(store.delete("rec/serving"), "aws_denied", false);
  await rejectsWith(store.get("../x"), "invalid_input", false);
  await rejectsWith(store.delete("/abs"), "invalid_input", false);
  assert.equal(mem.stub.calls.length, 1);
});

test("a malformed root is refused at wiring time", () => {
  const ssm = new SSMClient(offlineConfig);
  for (const root of ["dozebox/box-1/", "/dozebox/box-1", "/", "/a//b/"]) {
    assert.throws(() => makeAwsRecordStore({ ssm, root }), /not a parameter root/);
  }
});
