// A4: `dozebox-boot` (oneshot before dozeboxd): attach the data volume, then mount it, each a timeline step. A failed
// step writes `rec/last-error` (`boot:attach`, `boot:mount`) and the timeline, and exits 1, so the unit fails and its
// `OnFailure=dozebox-park-now.service` parks the box. Running it again in the same boot is harmless: attach sees its
// own attachment and mount sees /data mounted.
import { toInstant, type Clock } from "@dozebox/core/time";
import { messageOf } from "../errors.ts";
import type { Exec } from "../ports/exec.ts";
import type { Files } from "../ports/files.ts";
import type { Logger } from "../ports/log.ts";
import type { ParameterReader } from "../ports/params.ts";
import type { RecordWriter } from "../ports/records.ts";
import type { VolumeAttach } from "../ports/volumes.ts";
import type { RecordPublisher } from "../records/publish.ts";
import { attachDataVolume } from "./attach.ts";
import { mountDataVolume, resolveDataDevice } from "./mount.ts";
import { bootTimeOf, makeBootTimeline } from "./timeline.ts";

/** Core's `rec/formatted` (FormattedRecord); written and read raw, before the record publisher exists. */
export const FORMATTED_RECORD = "rec/formatted";

export type BootDeps = {
  readonly clock: Clock;
  readonly log: Logger;
  readonly exec: Exec;
  readonly files: Pick<Files, "readText" | "writeAtomic">;
  readonly exists: (path: string) => Promise<boolean>;
  readonly volumes: VolumeAttach;
  readonly params: ParameterReader;
  readonly records: Pick<RecordPublisher, "put" | "lastError">;
  readonly recordWriter: RecordWriter;
  readonly identity: {
    readonly boxId: string;
    readonly instanceId: string;
    readonly availabilityZone: string;
    readonly bootId: string;
  };
};

class BootStepFailed extends Error {}

/** Formatted when `rec/formatted` names `volumeId` (a record for an older volume does not count). */
export async function formattedFor(params: ParameterReader, volumeId: string): Promise<boolean> {
  const text = await params.get(FORMATTED_RECORD);
  if (text === null) return false;
  try {
    return (JSON.parse(text) as { volumeId?: unknown } | null)?.volumeId === volumeId;
  } catch {
    return false;
  }
}

/** Exit code for the unit: 0 mounted, 1 failed (recorded). */
export async function runBoot(deps: BootDeps, signal: AbortSignal): Promise<number> {
  const log = deps.log.child({ component: "boot" });
  const timeline = makeBootTimeline({
    clock: deps.clock,
    records: deps.records,
    files: deps.files,
    bootAt: await bootTimeOf(deps.files, deps.clock.now()),
  });
  const failed = async (source: string, message: string): Promise<number> => {
    log.log("error", "boot failed", { source, message });
    await deps.records.lastError(source, message).catch((e: unknown) => log.log("error", "no rec/last-error", { e }));
    await timeline.publish().catch((e: unknown) => log.log("error", "no rec/boot-timeline", { e }));
    return 1;
  };
  const id = deps.identity;
  try {
    const attached = await timeline.step("attach", async () => {
      const a = await attachDataVolume(
        deps,
        { boxId: id.boxId, instanceId: id.instanceId, zone: id.availabilityZone },
        signal,
      );
      if (a.kind === "refused") throw new BootStepFailed(`attach refused: ${a.why}`);
      return a;
    });
    log.log("info", "data volume attached", { volumeId: attached.volumeId });
    try {
      const out = await timeline.step("mount", async () => {
        const device = await resolveDataDevice(deps, attached.volumeId, attached.device, signal);
        return mountDataVolume(
          {
            exec: deps.exec,
            formatted: () => formattedFor(deps.params, attached.volumeId),
            markFormatted: () =>
              deps.recordWriter.put(
                FORMATTED_RECORD,
                JSON.stringify({
                  v: 1,
                  at: toInstant(deps.clock.now()),
                  writer: { instanceId: id.instanceId, bootId: id.bootId },
                  volumeId: attached.volumeId,
                }),
                { tier: "Standard" },
              ),
          },
          device,
          signal,
        );
      });
      log.log("info", "data volume mounted", { ...out });
      return 0;
    } catch (e) {
      return failed("boot:mount", messageOf(e));
    }
  } catch (e) {
    return failed("boot:attach", messageOf(e));
  }
}
