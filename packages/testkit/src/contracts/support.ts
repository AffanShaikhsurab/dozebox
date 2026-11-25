// Shared bits of the cloud port contract suites.
import { strict as assert } from "node:assert";
import { RunnerError, type RunnerErrorCode } from "@dozebox/core/errors";

export type ContractOptions = {
  /** Skip the whole suite with this reason (the emulator is not running, say). Fails instead where it is required. */
  readonly skip?: string | false;
  /** Cases this target cannot run, by case key. */
  readonly gaps?: Gaps;
};

/**
 * Cases a target cannot run, by case key, with the reason. The emulator models less than AWS (no Spot requests,
 * no snapshots); those cases stay covered by FakeAws and the recorded fixtures.
 */
export type Gaps = Readonly<Record<string, string>>;

export const gap = (gaps: Gaps | undefined, key: string): { skip?: string } => {
  const why = gaps?.[key];
  return why ? { skip: why } : {};
};

export async function rejectsWith(p: Promise<unknown>, code: RunnerErrorCode, retryable?: boolean): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RunnerError, `expected a RunnerError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (retryable !== undefined) assert.equal(e.retryable, retryable, e.message);
    return true;
  });
}

let counter = 0;
/** A name no other case of this run uses (targets are shared between cases). */
export const fresh = (prefix: string): string =>
  `${prefix}-${process.pid.toString(36)}-${(counter++).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
