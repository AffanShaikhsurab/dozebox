// The box's record writer on a stubbed SDK client: the recordStore contract offline (read back through the same
// in-memory Parameter Store; the box never reads records), then the request shapes.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SSMClient } from "@aws-sdk/client-ssm";
import { fromAws } from "@dozebox/core/errors";
import { recordStoreContract, rejectsWith } from "@dozebox/testkit/contracts";
import { offlineConfig, sdkError, ssmMemory } from "@dozebox/testkit/wire";
import { makeAwsRecordWriter } from "../src/adapters/aws/ssm.ts";

const ROOT = "/dozebox/box-1/";

function setup() {
  const ssm = new SSMClient(offlineConfig);
  const mem = ssmMemory(ssm, () => 1_700_000_000_000);
  return { mem, writer: makeAwsRecordWriter({ ssm, root: ROOT }) };
}

recordStoreContract("aws ssm record writer (stubbed client)", async () => {
  const { mem, writer } = setup();
  const stored = (name: string) => {
    const p = mem.parameters.get(`${ROOT}${name}`);
    return p ? { name, value: p.value, modifiedAt: p.modifiedAt } : null;
  };
  let getFault: { name: string; status: number } | null = null;
  return {
    writer,
    reader: {
      get: async (name) => {
        if (getFault) {
          const f = getFault;
          getFault = null;
          throw fromAws(sdkError(f.name, f.status));
        }
        return stored(name);
      },
      readAll: async () =>
        [...mem.parameters.keys()]
          .filter((k) => k.startsWith(ROOT))
          .map((k) => stored(k.slice(ROOT.length)))
          .filter((r) => r !== null),
    },
    calls: () => mem.stub.calls.length,
    inject: (op, name, status) => {
      if (op === "put") mem.stub.fail("PutParameterCommand", name, status);
      else getFault = { name, status };
    },
  };
});

test("put sends a String parameter under the root with the record's tier and Overwrite", async () => {
  const { mem, writer } = setup();
  await writer.put("rec/liveness", "{}", { tier: "Advanced" });
  assert.deepEqual(mem.stub.inputs("PutParameterCommand"), [
    { Name: "/dozebox/box-1/rec/liveness", Value: "{}", Type: "String", Tier: "Advanced", Overwrite: true },
  ]);
});

test("a Standard write over an Advanced parameter is repeated once as Advanced", async () => {
  const { mem, writer } = setup();
  await writer.put("rec/serving", "x".repeat(5000), { tier: "Advanced" });
  await writer.put("rec/serving", "small", { tier: "Standard" });
  assert.deepEqual(
    mem.stub.inputs("PutParameterCommand").map((i) => i["Tier"]),
    ["Advanced", "Standard", "Advanced"],
  );
  mem.stub.fail("PutParameterCommand", "ValidationException", 400, "You can't downgrade a parameter");
  mem.stub.fail("PutParameterCommand", "AccessDeniedException", 400);
  await rejectsWith(writer.put("rec/serving", "x", { tier: "Standard" }), "aws_denied", false);
});

test("other put errors are mapped and not retried; delete maps errors other than not-found", async () => {
  const { mem, writer } = setup();
  mem.stub.fail("PutParameterCommand", "ValidationException", 400, "something else");
  await rejectsWith(writer.put("rec/serving", "x", { tier: "Standard" }), "invalid_input", false);
  mem.stub.fail("PutParameterCommand", "ValidationException", 400, "downgrade");
  await rejectsWith(writer.put("rec/liveness", "x", { tier: "Advanced" }), "invalid_input", false);
  assert.equal(mem.stub.inputs("PutParameterCommand").length, 2);
  mem.stub.fail("DeleteParameterCommand", "ThrottlingException", 400);
  await rejectsWith(writer.delete("rec/serving"), "aws_throttled", true);
  await rejectsWith(writer.delete("../x"), "invalid_input", false);
});

test("a malformed root is refused at wiring time", () => {
  const ssm = new SSMClient(offlineConfig);
  assert.throws(() => makeAwsRecordWriter({ ssm, root: "/dozebox/box-1" }), /not a parameter root/);
});
