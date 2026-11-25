// Wire: the SSM record store against the emulator (`pnpm test:wire`; skips when the emulator is not running).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SSMClient } from "@aws-sdk/client-ssm";
import { fresh, recordStoreContract } from "@dozebox/testkit/contracts";
import { countCalls, faultInjector, resolveWire } from "@dozebox/testkit/wire";
import { makeAwsRecordStore } from "../../src/adapters/aws/ssm.ts";

const target = await resolveWire();

function make() {
  const ssm = new SSMClient(target.config);
  const inject = faultInjector(ssm);
  const calls = countCalls(ssm);
  const store = makeAwsRecordStore({ ssm, root: `/dozebox/${fresh("box")}/` });
  return { ssm, inject, calls, store };
}

recordStoreContract(
  "aws ssm adapter on the emulator",
  async () => {
    const { inject, calls, store } = make();
    return {
      writer: store,
      reader: store,
      calls,
      // Throttling and denial cannot be provoked on the emulator on demand: injected in the client (unit-only rows).
      inject: (op, name, status) => inject(op === "put" ? "PutParameterCommand" : "GetParameterCommand", name, status),
    };
  },
  { skip: target.skip },
);

test("wire ssm: a Standard write after an Advanced one still lands", { skip: target.skip }, async () => {
  const { store } = make();
  await store.put("rec/wakes", "x".repeat(6000), { tier: "Advanced" });
  await store.put("rec/wakes", "small", { tier: "Standard" });
  assert.equal((await store.get("rec/wakes"))?.value, "small");
});
