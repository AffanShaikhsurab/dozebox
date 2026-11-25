// Wire: the box's parameter reader (config and payload definitions) against the emulator (`pnpm test:wire`; skips
// when the emulator is not running). Terraform writes these parameters; here the record writer seeds them.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SSMClient } from "@aws-sdk/client-ssm";
import { fresh } from "@dozebox/testkit/contracts";
import { resolveWire } from "@dozebox/testkit/wire";
import { makeAwsParameterReader, makeAwsRecordWriter } from "../../src/adapters/aws/ssm.ts";

const target = await resolveWire();

test("reads config and payloads/<name>; a missing parameter is null", { skip: target.skip }, async () => {
  const root = `/dozebox/${fresh("box")}/`;
  const ssm = new SSMClient(target.config);
  const writer = makeAwsRecordWriter({ ssm, root });
  await writer.put("config", '{"schema":1}', { tier: "Standard" });
  await writer.put("payloads/web", '{"name":"web"}', { tier: "Standard" });
  const reader = makeAwsParameterReader({ ssm, root });
  assert.equal(await reader.get("config"), '{"schema":1}');
  assert.equal(await reader.get("payloads/web"), '{"name":"web"}');
  assert.equal(await reader.get("payloads/none"), null);
});
