// C6: the weekly restore test: a volume from the newest snapshot (in the active volume's zone), checked by `verify`,
// then deleted. Close time derives from the start. The scratch volume is inactive, so the tag fence keeps every box
// instance from attaching it.
import type { Volumes } from "../ports/volumes.ts";

export type RestoreTestState =
  | { readonly phase: "idle"; readonly lastResult: RestoreTestResult | null }
  | {
      readonly phase: "running";
      readonly startedAt: number;
      readonly volumeId: string;
      readonly snapshotId: string;
      readonly closeAt: number;
    };

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
  /** Judge the restored volume (the payload's `verifyRestore`, where a box can run it). */
  readonly verify: (volumeId: string) => Promise<{ readonly ok: boolean; readonly detail: string }>;
};

export interface RestoreTest {
  /** One step per tick: start when due, check, or close after `closeAfterMs`. */
  readonly step: (now: number, token: number) => Promise<RestoreTestState>;
}

export const RESTORE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function makeRestoreTest(deps: RestoreTestDeps): RestoreTest {
  const idle = async (now: number, token: number, snapshotId: string, detail: string): Promise<RestoreTestState> => {
    const next: RestoreTestState = { phase: "idle", lastResult: { at: now, ok: false, snapshotId, detail } };
    await deps.write(next, token);
    return next;
  };

  const start = async (now: number, token: number): Promise<RestoreTestState> => {
    const snap = await deps.volumes.newestSnapshot(deps.boxId);
    if (snap === null) return idle(now, token, "", "no snapshot");
    const zone = (await deps.volumes.describeBox(deps.boxId)).find((v) => v.active)?.zone;
    if (zone === undefined) return idle(now, token, snap.id, "no active volume");
    // Stable token: a retry after a crash before `write` gets the same volume, not a second one.
    const volumeId = await deps.volumes.createFromSnapshot({
      boxId: deps.boxId,
      snapshotId: snap.id,
      zone,
      token: `restore-test-${deps.boxId}-${snap.id}`,
    });
    const next: RestoreTestState = {
      phase: "running",
      startedAt: now,
      volumeId,
      snapshotId: snap.id,
      closeAt: now + deps.closeAfterMs,
    };
    await deps.write(next, token);
    return next;
  };

  const close = async (
    s: Extract<RestoreTestState, { phase: "running" }>,
    now: number,
    token: number,
  ): Promise<RestoreTestState> => {
    const verdict = await deps.verify(s.volumeId);
    await deps.volumes.deleteVolume(s.volumeId, `restore-test-delete-${s.volumeId}`);
    const next: RestoreTestState = {
      phase: "idle",
      lastResult: { at: now, ok: verdict.ok, snapshotId: s.snapshotId, detail: verdict.detail },
    };
    await deps.write(next, token);
    return next;
  };

  return {
    step: async (now, token) => {
      const s = await deps.read();
      if (s.phase === "running") return now >= s.closeAt ? close(s, now, token) : s;
      const last = s.lastResult;
      return last === null || now - last.at >= RESTORE_INTERVAL_MS ? start(now, token) : s;
    },
  };
}
