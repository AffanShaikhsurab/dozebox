// The `groupPort` contract: the On-Demand fallback group part of Compute (desired capacity and its machines).
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import type { Compute } from "@dozebox/control/ports/compute";
import type { RunnerErrorCode } from "@dozebox/core/errors";
import { fresh, rejectsWith, type ContractOptions } from "./support.ts";

export type GroupOp = "describe" | "set";

export type GroupHarness = {
  readonly compute: Pick<Compute, "describeGroup" | "setGroupDesired">;
  /** Create a min 0 / max 1 group at desired 0 for `boxId`. */
  readonly seedGroup: (name: string, boxId: string) => Promise<void>;
  readonly inject: (op: GroupOp, name: string, status: number) => void;
};

const STATES = new Set(["pending", "running", "stopping", "stopped", "shutting-down", "terminated"]);

export function groupPortContract(name: string, make: () => Promise<GroupHarness>, opts: ContractOptions = {}): void {
  describe(`groupPort: ${name}`, { skip: opts.skip ?? false }, () => {
    test("a new group reads desired 0 and no machines", async () => {
      const h = await make();
      const g = fresh("dz-g");
      await h.seedGroup(g, fresh("box"));
      assert.deepEqual(await h.compute.describeGroup(g), { desired: 0, machines: [] });
    });

    test("raise to 1, raise again with the same token, lower to 0", async () => {
      const h = await make();
      const g = fresh("dz-g");
      await h.seedGroup(g, fresh("box"));
      await h.compute.setGroupDesired(g, 1, "intent-1:0");
      await h.compute.setGroupDesired(g, 1, "intent-1:0");
      const up = await h.compute.describeGroup(g);
      assert.equal(up.desired, 1);
      assert.ok(up.machines.length <= 1);
      for (const m of up.machines) {
        assert.ok(STATES.has(m.state), m.state);
        assert.match(m.id, /^i-[0-9a-f]+$/);
      }
      await h.compute.setGroupDesired(g, 0, "intent-2:0");
      assert.equal((await h.compute.describeGroup(g)).desired, 0);
    });

    test("a group that does not exist -> aws_not_found, for describe and set", async () => {
      const h = await make();
      const g = fresh("dz-missing");
      await rejectsWith(h.compute.describeGroup(g), "aws_not_found", false);
      await rejectsWith(h.compute.setGroupDesired(g, 1, "t"), "aws_not_found", false);
    });

    const injected: ReadonlyArray<readonly [GroupOp, string, number, RunnerErrorCode, boolean]> = [
      ["set", "ScalingActivityInProgress", 400, "aws_conflict", true],
      ["set", "ResourceContention", 500, "aws_conflict", true],
      ["set", "AccessDenied", 403, "aws_denied", false],
      ["describe", "Throttling", 400, "aws_throttled", true],
    ];
    for (const [op, awsName, status, code, retryable] of injected) {
      test(`${op} failing with ${awsName} -> ${code}`, async () => {
        const h = await make();
        const g = fresh("dz-g");
        await h.seedGroup(g, fresh("box"));
        h.inject(op, awsName, status);
        await rejectsWith(
          op === "set" ? h.compute.setGroupDesired(g, 1, "t") : h.compute.describeGroup(g),
          code,
          retryable,
        );
      });
    }
  });
}
