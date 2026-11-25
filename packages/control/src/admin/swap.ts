// swap-volume: move `active=true` to another volume of this box, inside the reconcile lease, only while the box is
// parked (nothing runs that could hold either volume).
import { RunnerError } from "@dozebox/core/errors";
import type { Deps } from "../deps.ts";
import { gatherFacts } from "../status/build.ts";

export type SwapAnswer = { readonly ok: true; readonly active: string; readonly previous: string | null };

const invalid = (msg: string): RunnerError => new RunnerError("invalid_input", false, msg);

export async function swapVolume(deps: Deps, volumeId: string, reason: string): Promise<SwapAnswer> {
  const held = await deps.leases.acquire("reconcile");
  if (held === null) throw new RunnerError("aws_conflict", true, "another reconcile holds the lease; retry shortly");
  const boxId = deps.config.box.id;
  const facts = await gatherFacts(deps, deps.clock.now());
  const asleep = facts.desired.want === "asleep";
  const persistentDown = facts.persistent === null || ["stopped", "terminated"].includes(facts.persistent.state);
  const groupsDown = facts.groups.every(
    (g) => g.desired === 0 && g.machines.every((m) => m.state === "stopped" || m.state === "terminated"),
  );
  if (!asleep || !persistentDown || !groupsDown) throw invalid("the box is not parked: park first");

  const volumes = await deps.volumes.describeBox(boxId);
  const target = volumes.find((v) => v.id === volumeId);
  if (target === undefined) throw invalid(`${volumeId} is not a volume of box ${boxId}`);
  const previous = volumes.find((v) => v.active)?.id ?? null;
  if (previous === volumeId) return { ok: true, active: volumeId, previous };
  if (target.attachments.some((a) => a.state !== "detached"))
    throw invalid(`${volumeId} is still attached; park first`);
  if (volumes.some((v) => v.id === previous && v.attachments.some((a) => a.state !== "detached"))) {
    throw invalid(`${previous} is still attached; park first`);
  }

  await deps.volumes.moveActive(boxId, previous, volumeId);
  deps.log.log("info", "admin swap-volume", { volumeId, previous, reasonChars: reason.length });
  return { ok: true, active: volumeId, previous };
}
