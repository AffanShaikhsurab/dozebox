// Wire: the DynamoDB state table against the emulator (`pnpm test:wire`; skips when the emulator is not running).
// One table for the file, keyed like the module's (`pk` S, TTL attribute `ttl`); each case uses fresh keys.
import { CreateTableCommand, DynamoDBClient, UpdateTimeToLiveCommand } from "@aws-sdk/client-dynamodb";
import { fresh, stateTableContract } from "@dozebox/testkit/contracts";
import { faultInjector, resolveWire } from "@dozebox/testkit/wire";
import { makeAwsStateTable } from "../../src/adapters/aws/dynamodb.ts";

const target = await resolveWire();
const tableName = fresh("dozebox-state");

let created: Promise<void> | null = null;
const ensureTable = (db: DynamoDBClient): Promise<void> =>
  (created ??= (async () => {
    await db.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    await db.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      }),
    );
  })());

stateTableContract(
  "aws dynamodb adapter on the emulator",
  async () => {
    const db = new DynamoDBClient(target.config);
    await ensureTable(db);
    const inject = faultInjector(db);
    let offset = 0;
    const now = () => Date.now() + offset;
    return {
      table: makeAwsStateTable({ db, table: tableName, now }),
      pass: async (ms) => {
        offset += ms;
      },
      now,
      // Throttling and 5xx cannot be provoked on the emulator on demand: injected in the client (unit-only rows).
      inject: (op, name, status) => {
        if (op === "get") inject("GetItemCommand", name, status);
        else {
          inject("PutItemCommand", name, status);
          inject("UpdateItemCommand", name, status);
        }
      },
    };
  },
  { skip: target.skip },
);
