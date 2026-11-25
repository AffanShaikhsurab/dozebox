// Wire: the agent's self-stop adapter against the emulator (there is no shared contract suite for SelfStop).
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { fresh } from "@dozebox/testkit/contracts";
import { eventually, resolveWire } from "@dozebox/testkit/wire";
import { makeAwsSelfStop } from "../../src/adapters/aws/ec2.ts";
import { clients, createGroup, groupDesired, instanceState, runInstance } from "./seed.ts";

const target = await resolveWire();

describe("selfStop: aws adapter on the emulator", { skip: target.skip }, () => {
  test("persistent: the instance stops, and stopping it again is not an error", async () => {
    const { ec2, asg } = clients(target.config);
    const self = makeAwsSelfStop({ ec2, asg });
    const id = await runInstance(ec2);
    await self.stopSelf({ mode: "persistent", instanceId: id });
    await eventually(async () => (await instanceState(ec2, id)) === "stopped", `${id} stopped`);
    await self.stopSelf({ mode: "persistent", instanceId: id });
  });

  test("group: desired capacity goes to 0", async () => {
    const { ec2, asg } = clients(target.config);
    const self = makeAwsSelfStop({ ec2, asg });
    const name = fresh("dz-g");
    await createGroup(ec2, asg, name, 1);
    await self.stopSelf({ mode: "group", instanceId: "i-0000000000000self", groupName: name });
    assert.equal(await groupDesired(asg, name), 0);
  });

  test("group: a group that does not exist -> aws_not_found", async () => {
    const { ec2, asg } = clients(target.config);
    await assert.rejects(
      makeAwsSelfStop({ ec2, asg }).stopSelf({ mode: "group", instanceId: "i-1", groupName: fresh("dz-missing") }),
      (e: unknown) => e instanceof Error && "code" in e && e.code === "aws_not_found",
    );
  });
});
