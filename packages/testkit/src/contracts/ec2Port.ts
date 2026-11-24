// The `ec2Port` contract: the persistent machine part of Compute (describe, start, stop, tokens, error mapping).
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import type { Compute, MachineState } from "@dozebox/control/ports/compute";
import type { RunnerErrorCode } from "@dozebox/core/errors";
import { fresh, gap, rejectsWith, type ContractOptions } from "./support.ts";

export type Ec2Op = "describe" | "start" | "stop";

export type Ec2Harness = {
  readonly compute: Pick<Compute, "describePersistent" | "startPersistent" | "stopPersistent">;
  /** Create the box's persistent machine, tagged the way the module tags it, in `state`. Returns its id. */
  readonly seedPersistent: (boxId: string, state: "running" | "stopped") => Promise<string>;
  /** Let the cloud finish its transitions until describePersistent(boxId) reads `want`. */
  readonly settle: (boxId: string, want: MachineState) => Promise<void>;
  /** Make the next `op` call fail with AWS error `name` and HTTP `status`. */
  readonly inject: (op: Ec2Op, name: string, status: number) => void;
};

const STATES: ReadonlyArray<MachineState> = [
  "pending",
  "running",
  "stopping",
  "stopped",
  "shutting-down",
  "terminated",
];
const MISSING = "i-0000000000000dead";

export function ec2PortContract(name: string, make: () => Promise<Ec2Harness>, opts: ContractOptions = {}): void {
  describe(`ec2Port: ${name}`, { skip: opts.skip ?? false }, () => {
    test("describe of a box with no machine is null", async () => {
      const h = await make();
      assert.equal(await h.compute.describePersistent(fresh("nobox")), null);
    });

    test("describe returns the persistent machine as a MachineView", async () => {
      const h = await make();
      const box = fresh("box");
      const id = await h.seedPersistent(box, "stopped");
      await h.settle(box, "stopped");
      const v = await h.compute.describePersistent(box);
      assert.ok(v);
      assert.equal(v.id, id);
      assert.equal(v.state, "stopped");
      assert.ok(STATES.includes(v.state));
      assert.ok(["spot", "on-demand"].includes(v.lifecycle));
      assert.ok(["active", "disabled", "marked-for-stop", "none"].includes(v.spotRequest));
      assert.ok(Number.isFinite(v.launchedAt));
    });

    test("start of a stopped machine goes pending then running", async () => {
      const h = await make();
      const box = fresh("box");
      const id = await h.seedPersistent(box, "stopped");
      await h.settle(box, "stopped");
      await h.compute.startPersistent(id, "intent-1:0");
      const right = await h.compute.describePersistent(box);
      assert.ok(right && ["pending", "running"].includes(right.state), String(right?.state));
      await h.settle(box, "running");
    });

    test("start of a running machine, and the same token twice, are not errors", async () => {
      const h = await make();
      const box = fresh("box");
      const id = await h.seedPersistent(box, "running");
      await h.settle(box, "running");
      await h.compute.startPersistent(id, "intent-2:0");
      await h.compute.startPersistent(id, "intent-2:0");
      await h.settle(box, "running");
    });

    test("stop of a running machine ends stopped, with the time the stop began", async () => {
      const h = await make();
      const box = fresh("box");
      const id = await h.seedPersistent(box, "running");
      await h.settle(box, "running");
      await h.compute.stopPersistent(id, "intent-3:0");
      await h.settle(box, "stopped");
      await h.compute.stopPersistent(id, "intent-3:0");
      const v = await h.compute.describePersistent(box);
      assert.equal(v?.state, "stopped");
    });

    test("stop records stoppingAt with one-second resolution", gap(opts.gaps, "stoppingAt"), async () => {
      const h = await make();
      const box = fresh("box");
      const id = await h.seedPersistent(box, "running");
      await h.settle(box, "running");
      await h.compute.stopPersistent(id, "intent-4:0");
      const v = await h.compute.describePersistent(box);
      assert.ok(v?.stoppingAt !== null && v?.stoppingAt !== undefined, "stoppingAt is set once a stop began");
      assert.equal(v.stoppingAt % 1000, 0);
    });

    test("start or stop of a machine that does not exist -> aws_not_found", async () => {
      const h = await make();
      await rejectsWith(h.compute.startPersistent(MISSING, "t"), "aws_not_found", false);
      await rejectsWith(h.compute.stopPersistent(MISSING, "t"), "aws_not_found", false);
    });

    const injected: ReadonlyArray<readonly [Ec2Op, string, number, RunnerErrorCode, boolean]> = [
      ["start", "IncorrectSpotRequestState", 400, "aws_conflict", true],
      ["start", "InsufficientInstanceCapacity", 500, "aws_capacity", true],
      ["start", "UnauthorizedOperation", 403, "aws_denied", false],
      ["stop", "IncorrectInstanceState", 400, "aws_conflict", true],
      ["describe", "RequestLimitExceeded", 503, "aws_throttled", true],
      ["describe", "InternalError", 500, "aws_unavailable", true],
    ];
    for (const [op, awsName, status, code, retryable] of injected) {
      test(`${op} failing with ${awsName} -> ${code}`, async () => {
        const h = await make();
        const box = fresh("box");
        const id = await h.seedPersistent(box, "stopped");
        h.inject(op, awsName, status);
        const call =
          op === "describe"
            ? h.compute.describePersistent(box)
            : op === "start"
              ? h.compute.startPersistent(id, "t")
              : h.compute.stopPersistent(id, "t");
        await rejectsWith(call, code, retryable);
      });
    }
  });
}
