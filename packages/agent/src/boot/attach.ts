// A4: attach the box's data volume at boot (part 9 §9.2.3). The volume must be the one tagged `<prefix>:box=<boxId>`
// and `<prefix>:active=true` (the port's findActive) in this machine's zone. A volume still attached to another
// machine (a predecessor that is stopping after a reclaim) is waited for up to ATTACH_WAIT_MS and never
// force-detached: two machines writing one filesystem loses data, a box that stays parked does not.
import { RunnerError } from "@dozebox/core/errors";
import type { Clock } from "@dozebox/core/time";
import type { AttachedVolume, VolumeAttach } from "../ports/volumes.ts";

export const DATA_DEVICE = "/dev/sdf";
export const ATTACH_WAIT_MS = 5 * 60_000;
const ATTACH_POLL_MS = 5_000;

export type AttachOutcome =
  | { readonly kind: "attached"; readonly volumeId: string; readonly device: string }
  | { readonly kind: "refused"; readonly why: "no-active-volume" | "not-active" | "wrong-zone" | "attached-elsewhere" };

type Who = { readonly boxId: string; readonly instanceId: string; readonly zone: string };

const mine = (v: AttachedVolume, who: Who): boolean =>
  v.attachment?.machineId === who.instanceId && v.attachment.state === "attached";

export async function attachDataVolume(
  deps: { readonly volumes: VolumeAttach; readonly clock: Pick<Clock, "now" | "sleep"> },
  who: Who,
  signal: AbortSignal,
): Promise<AttachOutcome> {
  const deadline = deps.clock.now() + ATTACH_WAIT_MS;
  const wait = () => deps.clock.sleep(ATTACH_POLL_MS, signal);

  let v = await deps.volumes.findActive(who.boxId);
  if (!v) return { kind: "refused", why: "no-active-volume" };
  if (!v.active) return { kind: "refused", why: "not-active" };
  if (v.zone !== who.zone) return { kind: "refused", why: "wrong-zone" };
  const attached = { kind: "attached", volumeId: v.id, device: DATA_DEVICE } as const;
  if (mine(v, who)) return attached;

  while (v.attachment !== null && v.attachment.machineId !== who.instanceId) {
    if (deps.clock.now() >= deadline) return { kind: "refused", why: "attached-elsewhere" };
    await wait();
    const again = await deps.volumes.describe(v.id);
    if (!again) return { kind: "refused", why: "no-active-volume" };
    v = again;
  }
  if (!v.active) return { kind: "refused", why: "not-active" };

  if (v.attachment === null) {
    try {
      await deps.volumes.attach({ boxId: who.boxId, volumeId: v.id, machineId: who.instanceId, device: DATA_DEVICE });
    } catch (e) {
      // The tag fence said no between our read and the call (the volume was retired or moved).
      if (e instanceof RunnerError && e.code === "aws_denied") return { kind: "refused", why: "not-active" };
      throw e;
    }
  }
  for (;;) {
    const now = await deps.volumes.describe(v.id);
    if (now && mine(now, who)) return attached;
    if (now?.attachment && now.attachment.machineId !== who.instanceId) {
      return { kind: "refused", why: "attached-elsewhere" };
    }
    if (deps.clock.now() >= deadline) {
      throw new RunnerError(
        "internal",
        true,
        `volume ${v.id} did not reach attached within ${ATTACH_WAIT_MS / 1000} s`,
      );
    }
    await wait();
  }
}
