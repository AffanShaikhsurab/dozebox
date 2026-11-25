// The fake EC2 and EBS of the world (port of legacy world.mjs): the persistent Spot instance and its request, the
// data volume (single attach, the active tag as the fence), and the 120-second interruption notice.
import { MEASURED as M } from "../measured.ts";
import { AwsFault } from "./clock.ts";
import { terminateGroupInstance } from "./group.ts";
import type { Volume, World } from "./world.ts";

const volumeOf = (w: World, id: string): Volume | undefined => w.volumes.find((v) => v.id === id);

export function attachVolume(w: World, volumeId: string, instanceId: string, actor: string): void {
  const v = volumeOf(w, volumeId);
  const inst = w.instances.get(instanceId);
  if (!v) throw new AwsFault("InvalidVolume.NotFound");
  if (!inst || !(inst.state === "pending" || inst.state === "running"))
    throw new AwsFault("IncorrectState", `instance ${instanceId} is ${inst?.state}`);
  if (v.attachments.length > 0) throw new AwsFault("VolumeInUse", `${volumeId} is already attached`);
  w.hooks.action({ type: "attach", actor, volumeId, instanceId, active: v.active });
  const a = { instanceId, state: "attaching" as "attaching" | "attached" | "detaching" };
  v.attachments.push(a);
  w.log(`volume ${volumeId} attaching to ${instanceId}`);
  w.touch();
  w.at(
    w.draw(M.attachMs),
    () => {
      if (a.state !== "attaching" || !v.attachments.includes(a)) return;
      a.state = "attached";
      w.log(`volume ${volumeId} attached to ${instanceId}`);
      w.touch();
      w.at(w.draw(M.deviceAppearsMs), () => w.boxes.get(instanceId)?.onVolumeAttached(), "device");
    },
    "attach",
  );
}

export function detachVolume(w: World, volumeId: string, instanceId: string, actor: string): void {
  const v = volumeOf(w, volumeId);
  const a = v?.attachments.find((x) => x.instanceId === instanceId);
  if (!v || !a) throw new AwsFault("IncorrectState", `${volumeId} is not attached to ${instanceId}`);
  const inst = w.instances.get(instanceId);
  w.hooks.action({
    type: "detach",
    actor,
    volumeId,
    instanceId,
    instanceState: inst?.state,
    startedAt: inst?.startedAt ?? null,
  });
  if (a.state === "detaching") return;
  const remove = (): void => {
    v.attachments = v.attachments.filter((x) => x !== a);
    w.touch();
  };
  const box = w.boxes.get(instanceId);
  if (box?.mounted && !box.dead) {
    // ASSUMED: a non-forced detach of a volume the guest still has mounted stays busy until it is unmounted.
    w.log(`volume ${volumeId} detach from ${instanceId} is busy (${actor}, still mounted)`);
    const finish = (): void => {
      const b = w.boxes.get(instanceId);
      if (!b?.mounted || b.dead) remove();
      else w.at(5000, finish, "detach-busy");
    };
    w.at(5000, finish, "detach-busy");
    return;
  }
  a.state = "detaching";
  w.log(`volume ${volumeId} detaching from ${instanceId} (${actor}, instance ${inst?.state})`);
  w.touch();
  w.at(w.draw(M.detachMs), remove, "detach");
}

const requestStatus = (w: World, state: "active" | "disabled", statusCode: string): void => {
  w.spot = { state, statusCode, statusUpdatedAt: w.now };
};

export function startPersistent(w: World, id: string, actor: string): void {
  const p = w.instances.get(id);
  if (!p || p.kind !== "persistent") throw new AwsFault("InvalidInstanceID.NotFound");
  // ASSUMED, as documented: StartInstances on a pending or running instance succeeds without effect.
  if (p.state === "pending" || p.state === "running") return;
  if (p.state !== "stopped") throw new AwsFault("IncorrectInstanceState", `${id} is ${p.state}`);
  // A stop is not finished for EC2 until the persistent request reads `disabled`.
  if (w.spot.state !== "disabled")
    throw new AwsFault("IncorrectSpotRequestState", "the Spot request is not disabled yet");
  if (w.capacityOut() || (p.stoppedBy === "ec2" && w.chance(M.interruptedStartRefusedP)))
    throw new AwsFault("InsufficientInstanceCapacity", "no Spot capacity");
  w.hooks.action({ type: "start", actor, id });
  p.state = "pending";
  p.launchedAt = w.now;
  p.startedAt = w.now;
  p.notice = null;
  requestStatus(w, "active", "fulfilled");
  w.log(`persistent ${id} pending (start by ${actor})`);
  w.touch();
  w.at(
    w.draw(M.pendingMs),
    () => {
      if (p.state !== "pending") return;
      p.state = "running";
      w.touch();
      w.log(`persistent ${id} running`);
      w.hooks.running(p);
    },
    "running",
  );
}

/** `by` is why it stops (`user`: an API or guest stop, `ec2`: an interruption); `actor` is who asked. */
export function stopPersistent(w: World, id: string, by: "user" | "ec2", actor: string): void {
  const p = w.instances.get(id);
  if (!p || p.kind !== "persistent") throw new AwsFault("InvalidInstanceID.NotFound");
  if (p.state !== "pending" && p.state !== "running") return;
  w.hooks.action({ type: "stop", actor, id, holdsVolume: w.holdsVolume(id) });
  p.state = "stopping";
  w.stopTraces.push(w.now);
  p.stoppedBy = by;
  p.stoppingAt = w.now;
  requestStatus(w, "active", "marked-for-stop");
  w.log(`persistent ${id} stopping (${by}, ${actor})`);
  w.touch();
  w.at(3000, () => w.boxes.get(id)?.kill("stopping"), "box-down");
  w.at(
    w.draw(M.stopSettleMs),
    () => {
      if (p.state !== "stopping") return;
      p.state = "stopped";
      w.touch();
      w.log(`persistent ${id} stopped`);
      w.hooks.down(p);
      w.emit({ kind: "stopped", instanceId: id }, M.stateEventDelayMs);
      const after = p.stoppedBy === "ec2" ? M.requestDisabledAfterEc2StopMs : M.requestDisabledAfterUserStopMs;
      w.at(
        w.draw(after),
        () => {
          if (p.state !== "stopped") return;
          const code =
            p.stoppedBy === "ec2"
              ? p.fis
                ? "instance-stopped-by-experiment"
                : "instance-stopped-no-capacity"
              : "instance-stopped-by-user";
          requestStatus(w, "disabled", code);
          w.touch();
        },
        "request-disabled",
      );
    },
    "stopped",
  );
}

/** The 120-second notice. The instance goes away at its end unless it already stopped itself. */
export function reclaim(w: World, id: string, fis: boolean): boolean {
  const inst = w.instances.get(id);
  if (!inst || inst.state !== "running" || inst.lifecycle !== "spot" || inst.notice) return false;
  const notice = { at: w.now, stopAt: w.now + M.noticeLeadMs };
  inst.notice = notice;
  inst.fis = fis;
  w.log(`SPOT NOTICE ${id}`);
  w.hooks.event({ type: "notice", id, at: w.now });
  w.boxes.get(id)?.setNotice(notice);
  w.emit({ kind: "warning", instanceId: id }, M.warningEventDelayMs);
  w.at(
    M.noticeLeadMs,
    () => {
      if (inst.notice !== notice) return;
      if (inst.kind === "persistent") stopPersistent(w, id, "ec2", "ec2");
      else terminateGroupInstance(w, inst);
    },
    "reclaim",
  );
  return true;
}
