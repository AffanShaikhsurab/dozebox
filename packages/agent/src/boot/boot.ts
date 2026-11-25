// A4: boot (run by `dozebox-boot` before dozeboxd): tag-fenced attach (never force-detach), mount with mkfs guarded
// by `rec/formatted` and blkid, and the boot timeline written to `rec/boot-timeline`.
import type { Clock } from "@dozebox/core/time";
import type { Exec } from "../ports/exec.ts";
import type { VolumeAttach } from "../ports/volumes.ts";
import type { RecordPublisher } from "../records/publish.ts";

export const DATA_DEVICE = "/dev/sdf";
export const DATA_MOUNT = "/data";
export const ATTACH_WAIT_MS = 5 * 60_000;

export type AttachOutcome =
  | { readonly kind: "attached"; readonly volumeId: string; readonly device: string }
  | { readonly kind: "refused"; readonly why: "no-active-volume" | "not-active" | "wrong-zone" | "attached-elsewhere" };

export function attachDataVolume(
  _deps: { readonly volumes: VolumeAttach; readonly clock: Clock },
  _who: { readonly boxId: string; readonly instanceId: string; readonly zone: string },
  _signal: AbortSignal,
): Promise<AttachOutcome> {
  throw new Error("not implemented: A4 attachDataVolume");
}

export type MountOutcome = { readonly formatted: boolean; readonly mountedAt: string };

/** mkfs only when `rec/formatted` is absent and blkid finds no filesystem; then mount and bind the homes. */
export function mountDataVolume(
  _deps: {
    readonly exec: Exec;
    readonly formatted: () => Promise<boolean>;
    readonly markFormatted: () => Promise<void>;
  },
  _device: string,
  _signal: AbortSignal,
): Promise<MountOutcome> {
  throw new Error("not implemented: A4 mountDataVolume");
}

export type TimelineStep = {
  readonly step: string;
  readonly startedAt: number;
  readonly ms: number;
  readonly ok: boolean;
};

export interface BootTimeline {
  /** Time `fn` as `step`; a throw is recorded as not ok and rethrown. */
  readonly step: <T>(step: string, fn: () => Promise<T>) => Promise<T>;
  readonly steps: () => ReadonlyArray<TimelineStep>;
  /** Write `rec/boot-timeline`. */
  readonly publish: () => Promise<void>;
}

export function makeBootTimeline(_deps: {
  readonly clock: Pick<Clock, "now">;
  readonly records: Pick<RecordPublisher, "put">;
}): BootTimeline {
  throw new Error("not implemented: A4 makeBootTimeline");
}
