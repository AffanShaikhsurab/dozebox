// C6: the weekly restore test: a volume from the newest snapshot, a box woken on it in restore-test mode, the
// payload's `verifyRestore` run, the box parked, the test volume deleted. Close time derives from the start.
import type { Volumes } from "../ports/volumes.ts";

export type RestoreTestState =
  | { readonly phase: "idle"; readonly lastResult: RestoreTestResult | null }
  | { readonly phase: "running"; readonly startedAt: number; readonly volumeId: string; readonly closeAt: number };

export type RestoreTestResult = {
  readonly at: number;
  readonly ok: boolean;
  readonly snapshotId: string;
  readonly detail: string;
};

export type RestoreTestDeps = {
  readonly volumes: Volumes;
  readonly boxId: string;
  readonly closeAfterMs: number;
  readonly read: () => Promise<RestoreTestState>;
  readonly write: (s: RestoreTestState, token: number) => Promise<void>;
};

export interface RestoreTest {
  /** One step per tick: start when due, check, or close after `closeAfterMs`. */
  readonly step: (now: number, token: number) => Promise<RestoreTestState>;
}

export function makeRestoreTest(_deps: RestoreTestDeps): RestoreTest {
  throw new Error("not implemented: C6 makeRestoreTest");
}
