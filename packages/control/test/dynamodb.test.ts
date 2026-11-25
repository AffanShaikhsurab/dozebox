// The DynamoDB state table on a stubbed SDK client. The stub evaluates the three condition expressions the adapter
// sends (and refuses any other), one request at a time like DynamoDB, so the stateTable contract runs offline.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DynamoDBClient, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { rejectsWith, stateTableContract } from "@dozebox/testkit/contracts";
import { offlineConfig, sdkError, stubHandlers } from "@dozebox/testkit/wire";
import { makeAwsStateTable } from "../src/adapters/aws/dynamodb.ts";

type Item = Record<string, AttributeValue>;
type Input = Readonly<Record<string, unknown>>;

const LEASE = "attribute_not_exists(#pk) OR #e < :now OR #h = :h";
const FENCED = "attribute_not_exists(#f) OR #f <= :tok";
const ABSENT = "attribute_not_exists(#pk) OR #t < :now";

const values = (input: Input) => input["ExpressionAttributeValues"] as Record<string, AttributeValue>;
const num = (v: AttributeValue | undefined): number | undefined => (v?.N === undefined ? undefined : Number(v.N));
const pkOf = (input: Input, field: "Key" | "Item") => String((input[field] as Item)["pk"]?.S);
const failed = () => sdkError("ConditionalCheckFailedException", 400, "The conditional request failed");

function setup() {
  let clock = 1_700_000_000_000;
  const db = new DynamoDBClient(offlineConfig);
  const stub = stubHandlers(db);
  const items = new Map<string, Item>();
  stub.on("UpdateItemCommand", async (input) => {
    await new Promise((r) => setImmediate(r));
    assert.equal(input["ConditionExpression"], LEASE);
    const v = values(input);
    const pk = pkOf(input, "Key");
    const item = items.get(pk);
    const ok = !item || (num(item["expiresAt"]) ?? 0) < (num(v[":now"]) ?? 0) || item["holder"]?.S === v[":h"]?.S;
    if (!ok) throw failed();
    const fencing = (num(item?.["fencing"]) ?? 0) + (num(v[":one"]) ?? 0);
    const next: Item = {
      ...item,
      pk: { S: pk },
      holder: { S: String(v[":h"]?.S) },
      expiresAt: { N: String(v[":e"]?.N) },
      fencing: { N: String(fencing) },
    };
    items.set(pk, next);
    return { Attributes: { holder: next["holder"], expiresAt: next["expiresAt"], fencing: next["fencing"] } };
  });
  stub.on("PutItemCommand", async (input) => {
    await new Promise((r) => setImmediate(r));
    const v = values(input);
    const pk = pkOf(input, "Item");
    const item = items.get(pk);
    const condition = input["ConditionExpression"];
    const ok =
      condition === FENCED
        ? num(item?.["fencing"]) === undefined || (num(item?.["fencing"]) ?? 0) <= (num(v[":tok"]) ?? 0)
        : condition === ABSENT
          ? !item || (num(item["ttl"]) !== undefined && (num(item["ttl"]) ?? 0) < (num(v[":now"]) ?? 0))
          : assert.fail(`unexpected condition ${String(condition)}`);
    if (!ok) throw failed();
    items.set(pk, input["Item"] as Item);
    return {};
  });
  stub.on("GetItemCommand", (input) => {
    assert.equal(input["ConsistentRead"], true);
    const item = items.get(pkOf(input, "Key"));
    return item ? { Item: item } : {};
  });
  const table = makeAwsStateTable({ db, table: "dozebox-box-1", now: () => clock });
  return {
    stub,
    items,
    table,
    now: () => clock,
    pass: (ms: number) => {
      clock += ms;
    },
  };
}

stateTableContract("aws dynamodb adapter (stubbed client)", async () => {
  const s = setup();
  return {
    table: s.table,
    pass: async (ms) => s.pass(ms),
    now: s.now,
    inject: (op, name, status) => {
      if (op === "get") s.stub.fail("GetItemCommand", name, status);
      else {
        s.stub.fail("PutItemCommand", name, status);
        s.stub.fail("UpdateItemCommand", name, status);
      }
    },
  };
});

test("acquireLease sends one conditional UpdateItem on lease#<name> and reads the token back", async () => {
  const s = setup();
  const lease = await s.table.acquireLease("reconcile", "tick-a", 45_000, 1_000);
  assert.deepEqual(lease, { holder: "tick-a", token: 1, expiresAt: 46_000 });
  const [input] = s.stub.inputs("UpdateItemCommand");
  assert.deepEqual(input, {
    TableName: "dozebox-box-1",
    Key: { pk: { S: "lease#reconcile" } },
    UpdateExpression: "SET #h = :h, #e = :e ADD #f :one",
    ConditionExpression: LEASE,
    ExpressionAttributeNames: { "#pk": "pk", "#h": "holder", "#e": "expiresAt", "#f": "fencing" },
    ExpressionAttributeValues: {
      ":h": { S: "tick-a" },
      ":e": { N: "46000" },
      ":now": { N: "1000" },
      ":one": { N: "1" },
    },
    ReturnValues: "UPDATED_NEW",
  });
});

test("acquireLease: no token in the answer is an internal error; throttles are mapped", async () => {
  const s = setup();
  s.stub.on("UpdateItemCommand", () => ({ Attributes: {} }));
  await rejectsWith(s.table.acquireLease("reconcile", "tick-a", 45_000, 0), "internal", false);
  s.stub.fail("UpdateItemCommand", "ThrottlingException", 400);
  await rejectsWith(s.table.acquireLease("reconcile", "tick-a", 45_000, 0), "aws_throttled", true);
});

test("putFenced writes value and token; putIfAbsent writes a ttl in epoch seconds", async () => {
  const s = setup();
  await s.table.putFenced("desired", { state: "awake" }, 7);
  assert.equal(await s.table.putIfAbsent("idem#k1", { accepted: 1 }, 86_400), "written");
  const [fenced, absent] = s.stub.inputs("PutItemCommand");
  assert.deepEqual(fenced?.["Item"], {
    pk: { S: "kv#desired" },
    value: { S: '{"state":"awake"}' },
    fencing: { N: "7" },
  });
  assert.deepEqual(fenced?.["ExpressionAttributeValues"], { ":tok": { N: "7" } });
  assert.deepEqual(absent?.["Item"], {
    pk: { S: "kv#idem#k1" },
    value: { S: '{"accepted":1}' },
    ttl: { N: String(1_700_000_000 + 86_400) },
  });
  assert.deepEqual(absent?.["ExpressionAttributeNames"], { "#pk": "pk", "#t": "ttl" });
});

test("a fenced key is never overwritten by putIfAbsent", async () => {
  const s = setup();
  await s.table.putFenced("desired", 1, 3);
  s.pass(10 * 86_400_000);
  assert.equal(await s.table.putIfAbsent("desired", 2, 1), "exists");
  assert.equal(await s.table.get("desired"), 1);
});

test("an expired entry DynamoDB has not deleted yet reads as null", async () => {
  const s = setup();
  s.items.set("kv#old", { pk: { S: "kv#old" }, value: { S: "1" }, ttl: { N: String(1_700_000_000 - 1) } });
  assert.equal(await s.table.get("old"), null);
  s.items.set("kv#edge", { pk: { S: "kv#edge" }, value: { S: "2" }, ttl: { N: String(1_700_000_000) } });
  assert.equal(await s.table.get("edge"), 2);
});

test("a value with no JSON form is refused before the call; a stored non-JSON value is internal", async () => {
  const s = setup();
  await rejectsWith(s.table.putFenced("k", undefined, 1), "invalid_input", false);
  await rejectsWith(
    s.table.putIfAbsent("k", () => 1, 1),
    "invalid_input",
    false,
  );
  assert.equal(s.stub.inputs("PutItemCommand").length, 0);
  s.items.set("kv#bad", { pk: { S: "kv#bad" }, value: { S: "{nope" } });
  await rejectsWith(s.table.get("bad"), "internal", false);
});

test("putIfAbsent maps errors other than a failed condition", async () => {
  const s = setup();
  s.stub.fail("PutItemCommand", "AccessDeniedException", 400);
  await rejectsWith(s.table.putIfAbsent("k", 1, 1), "aws_denied", false);
});
