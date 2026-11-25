// AWS adapter for the control function's state table (part 6 §6.3: lease with a fencing token, idempotency keys).
// Table: partition key `pk` (S), TTL attribute `ttl` (N, epoch seconds), on-demand. Items:
//   lease#<name>  holder (S), expiresAt (N, epoch ms), fencing (N)           the reconcile lease
//   kv#<key>      value (S, JSON), fencing (N)                              a fenced write (no ttl, kept)
//   kv#<key>      value (S, JSON), ttl (N)                                  an idempotency entry
// Every write is one conditional request, so DynamoDB serializes racing writers: of two concurrent acquires of a
// free lease exactly one condition holds. ConditionalCheckFailedException maps to `lease_lost` (fromAws); the lease
// and putIfAbsent turn it into their value (null, "exists"). DynamoDB deletes expired items late (up to days), so
// reads and conditions compare `ttl` with the clock themselves. Reads are strongly consistent.
import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import type { Lease, StateTable } from "../../ports/state.ts";

export type AwsStateTableDeps = {
  readonly db: DynamoDBClient;
  readonly table: string;
  /** The clock idempotency entries expire by, in epoch ms. Default Date.now. */
  readonly now?: () => number;
};

// Attributes in expressions go through name placeholders: `ttl` is a DynamoDB reserved word.

const n = (v: number): AttributeValue => ({ N: String(v) });

function encode(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new RunnerError("invalid_input", false, "the value has no JSON form");
  return json;
}

const lostTo = <T>(e: unknown, outcome: T): T => {
  const err = fromAws(e);
  if (err.code === "lease_lost") return outcome;
  throw err;
};

export function makeAwsStateTable(deps: AwsStateTableDeps): StateTable {
  const { db, table } = deps;
  const nowSeconds = () => Math.floor((deps.now ?? Date.now)() / 1000);
  return {
    acquireLease: async (name, holder, ttlMs, now): Promise<Lease | null> => {
      const expiresAt = now + ttlMs;
      try {
        const out = await db.send(
          new UpdateItemCommand({
            TableName: table,
            Key: { pk: { S: `lease#${name}` } },
            UpdateExpression: "SET #h = :h, #e = :e ADD #f :one",
            ConditionExpression: "attribute_not_exists(#pk) OR #e < :now OR #h = :h",
            ExpressionAttributeNames: { "#pk": "pk", "#h": "holder", "#e": "expiresAt", "#f": "fencing" },
            ExpressionAttributeValues: { ":h": { S: holder }, ":e": n(expiresAt), ":now": n(now), ":one": n(1) },
            ReturnValues: "UPDATED_NEW",
          }),
        );
        const token = Number(out.Attributes?.["fencing"]?.N);
        if (!Number.isInteger(token) || token < 1) {
          throw new RunnerError("internal", false, `lease ${name}: the table returned no fencing token`);
        }
        return { holder, token, expiresAt };
      } catch (e) {
        return lostTo(e, null);
      }
    },

    putFenced: async (key, value, token) => {
      const json = encode(value);
      try {
        await db.send(
          new PutItemCommand({
            TableName: table,
            Item: { pk: { S: `kv#${key}` }, value: { S: json }, fencing: n(token) },
            ConditionExpression: "attribute_not_exists(#f) OR #f <= :tok",
            ExpressionAttributeNames: { "#f": "fencing" },
            ExpressionAttributeValues: { ":tok": n(token) },
          }),
        );
      } catch (e) {
        // A newer token wrote this key: lease_lost, thrown as the port says.
        throw fromAws(e);
      }
    },

    putIfAbsent: async (key, value, ttlSeconds) => {
      const json = encode(value);
      const now = nowSeconds();
      try {
        await db.send(
          new PutItemCommand({
            TableName: table,
            Item: { pk: { S: `kv#${key}` }, value: { S: json }, ttl: n(now + ttlSeconds) },
            // Absent, or an idempotency entry whose ttl passed. A fenced item (no ttl) always exists.
            ConditionExpression: "attribute_not_exists(#pk) OR #t < :now",
            ExpressionAttributeNames: { "#pk": "pk", "#t": "ttl" },
            ExpressionAttributeValues: { ":now": n(now) },
          }),
        );
        return "written";
      } catch (e) {
        return lostTo(e, "exists" as const);
      }
    },

    get: async (key) => {
      let item: Record<string, AttributeValue> | undefined;
      try {
        const out = await db.send(
          new GetItemCommand({ TableName: table, Key: { pk: { S: `kv#${key}` } }, ConsistentRead: true }),
        );
        item = out.Item;
      } catch (e) {
        throw fromAws(e);
      }
      const json = item?.["value"]?.S;
      if (json === undefined) return null;
      const ttl = item?.["ttl"]?.N;
      if (ttl !== undefined && Number(ttl) < nowSeconds()) return null;
      try {
        return JSON.parse(json) as unknown;
      } catch (e) {
        throw new RunnerError("internal", false, `state ${key}: the stored value is not JSON`, { cause: e });
      }
    },
  };
}
