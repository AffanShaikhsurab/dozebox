// C6: the restore test as one step of the reconcile tick, its state in `kv#restore-test` under the lease token.
// Verify is the smallest check the control function can make by itself: the volume restored from the snapshot reached
// `available`. Running the payload's `verifyRestore` hook needs a box booted on the
// scratch volume (the agent's restore-test mode), which does not exist yet.
import { Type } from "typebox";
import Value from "typebox/value";
import { KEYS } from "../state/keys.ts";
import type { TickDeps } from "../reconcile/types.ts";
import { makeRestoreTest, type RestoreTestState } from "./run.ts";

/** A gp3 volume from a small snapshot is `available` within minutes; the test closes after this long. */
const RESTORE_CLOSE_MS = 15 * 60_000;

const Ms = Type.Number({ minimum: 0 });
const Result = Type.Object({ at: Ms, ok: Type.Boolean(), snapshotId: Type.String(), detail: Type.String() });
const StateSchema = Type.Union([
  Type.Object({ phase: Type.Literal("idle"), lastResult: Type.Union([Result, Type.Null()]) }),
  Type.Object({
    phase: Type.Literal("running"),
    startedAt: Ms,
    volumeId: Type.String({ minLength: 1 }),
    snapshotId: Type.String({ minLength: 1 }),
    closeAt: Ms,
  }),
]);

const NEVER: RestoreTestState = { phase: "idle", lastResult: null };

export function restoreTestStep(
  deps: Pick<TickDeps, "config" | "state" | "volumes" | "clock">,
  token: number,
): Promise<RestoreTestState> {
  const box = deps.config.box.id;
  return makeRestoreTest({
    volumes: deps.volumes,
    boxId: box,
    closeAfterMs: RESTORE_CLOSE_MS,
    read: async () => {
      const raw = await deps.state.get(KEYS.restoreTest);
      return Value.Check(StateSchema, raw) ? raw : NEVER;
    },
    write: (s, t) => deps.state.putFenced(KEYS.restoreTest, s, t),
    verify: async (volumeId) => {
      const v = (await deps.volumes.describeBox(box)).find((x) => x.id === volumeId);
      if (v === undefined) return { ok: false, detail: "restored volume not found" };
      if (v.state !== "available") return { ok: false, detail: `restored volume ${v.state}` };
      return { ok: true, detail: `restored ${v.sizeGiB} GiB, available` };
    },
  }).step(deps.clock.now(), token);
}
