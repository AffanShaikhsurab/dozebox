// The fake Auto Scaling group of the world (port of legacy world.mjs): launch 5 to 15 s, failed launches while Spot
// has no capacity, the On-Demand switch, health-check replacement of a reclaimed instance, and desired capacity 0.
import { MEASURED as M } from "../measured.ts";
import type { Instance, World } from "./world.ts";

/** A terminated instance gives its volume back. */
function releaseVolumes(w: World, inst: Instance): void {
  for (const v of w.volumes) {
    const a = v.attachments.find((x) => x.instanceId === inst.id);
    if (!a || a.state === "detaching") continue;
    a.state = "detaching";
    w.at(
      w.draw(M.detachMs),
      () => {
        v.attachments = v.attachments.filter((x) => x !== a);
        w.touch();
      },
      "release",
    );
  }
}

function attemptLaunch(w: World): void {
  w.group.launching = false;
  if (w.group.desired < 1 || w.liveGroup().length >= 1) return;
  const onDemand = w.group.onDemandPercent === 100;
  if (!onDemand && w.capacityOut()) {
    w.log("group launch failed: no Spot capacity");
    w.at(M.launchRetryMs, () => ensureLaunch(w), "launch-retry");
    return;
  }
  const inst: Instance = {
    id: w.nextId("i-0group"),
    kind: "group",
    lifecycle: onDemand ? "on-demand" : "spot",
    az: "us-east-1a",
    state: "pending",
    launchedAt: w.now,
    startedAt: w.now,
    stoppingAt: null,
    stoppedBy: null,
    notice: null,
    fis: false,
  };
  w.hooks.action({ type: "launch", actor: "asg", id: inst.id });
  w.instances.set(inst.id, inst);
  w.group.entries.push({ id: inst.id, lifecycleState: "Pending" });
  w.log(`group launched ${inst.id} (${inst.lifecycle})`);
  w.touch();
  w.at(
    w.draw(M.pendingMs),
    () => {
      if (inst.state !== "pending") return;
      inst.state = "running";
      w.touch();
      w.hooks.running(inst);
      w.at(
        w.draw(M.inServiceMs),
        () => {
          const entry = w.group.entries.find((e) => e.id === inst.id);
          if (entry?.lifecycleState === "Pending") {
            entry.lifecycleState = "InService";
            w.touch();
          }
        },
        "in-service",
      );
    },
    "running",
  );
}

function ensureLaunch(w: World): void {
  if (w.group.desired < 1 || w.liveGroup().length >= 1 || w.group.launching) return;
  w.group.launching = true;
  w.touch();
  w.at(w.draw(M.groupLaunchMs), () => attemptLaunch(w), "launch");
}

/** EC2 ends a group instance (a reclaim): the group notices later and replaces it. */
export function terminateGroupInstance(w: World, inst: Instance): void {
  if (inst.state === "shutting-down" || inst.state === "terminated") return;
  inst.state = "shutting-down";
  w.log(`group ${inst.id} shutting down (ec2)`);
  w.hooks.down(inst);
  w.touch();
  w.at(3000, () => w.boxes.get(inst.id)?.kill("terminating"), "box-down");
  releaseVolumes(w, inst);
  w.at(
    w.draw(M.terminateMs),
    () => {
      inst.state = "terminated";
      w.touch();
    },
    "terminated",
  );
  w.at(
    w.draw(M.asgUnhealthyMs),
    () => {
      if (!w.group.entries.some((e) => e.id === inst.id)) return;
      w.group.entries = w.group.entries.filter((e) => e.id !== inst.id);
      w.touch();
      ensureLaunch(w);
    },
    "group-unhealthy",
  );
}

/** The group ends its own instance (desired capacity 0). */
function groupTerminate(w: World, inst: Instance): void {
  if (inst.state === "shutting-down" || inst.state === "terminated") return;
  const entry = w.group.entries.find((e) => e.id === inst.id);
  if (entry) entry.lifecycleState = "Terminating";
  inst.state = "shutting-down";
  w.stopTraces.push(w.now);
  w.groupTraces.push(w.now);
  w.log(`group ${inst.id} shutting down (group)`);
  w.hooks.down(inst);
  w.touch();
  w.at(3000, () => w.boxes.get(inst.id)?.kill("terminating"), "box-down");
  releaseVolumes(w, inst);
  w.at(
    w.draw(M.terminateMs),
    () => {
      inst.state = "terminated";
      w.group.entries = w.group.entries.filter((e) => e.id !== inst.id);
      w.touch();
      // desired may have been raised again while it ended
      ensureLaunch(w);
    },
    "terminated",
  );
}

export function setDesired(w: World, n: number, actor: string): void {
  w.hooks.action({ type: "setDesired", n, actor, groupHoldsVolume: w.groupHoldsVolume() });
  const before = w.group.desired;
  w.group.desired = n;
  w.log(`group desired ${before} -> ${n} (${actor})`);
  if (n < 1) {
    for (const entry of w.liveGroup()) {
      const inst = w.instances.get(entry.id);
      if (inst) groupTerminate(w, inst);
    }
  } else {
    ensureLaunch(w);
  }
  w.touch();
}

export function setOnDemandPercent(w: World, n: number): void {
  w.group.onDemandPercent = n;
  w.log(`group on-demand ${n}%`);
  w.touch();
}
