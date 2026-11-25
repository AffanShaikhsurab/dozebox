// Plays one seed's day on the world (port of legacy scenario.mjs schedule): wakes and sleeps by a person (with the
// CLI's retry), Spot reclaims of whichever instance runs, payload faults, capacity outages and the D-E tag windows.
import type { Control } from "./control/control.ts";
import { EPOCH, MINUTE } from "./world/clock.ts";
import { reclaim, stopPersistent } from "./world/ec2.ts";
import { setDesired } from "./world/group.ts";
import type { BoxHandle, World } from "./world/world.ts";

/** The first running box that answers, if any. */
const servingBox = (w: World): BoxHandle | undefined => [...w.boxes.values()].find((b) => b.serving());

export function schedule(w: World, control: Control): void {
  const { cfg } = w;
  const r = w.rng.fork("scenario");
  control.schedule(r);

  const wake = (attempt = 0): void => {
    const at = w.now;
    w.log("person: wake");
    w.hooks.event({
      type: "wake-request",
      at,
      truth: {
        persistent: w.persistent.state,
        request: w.spot.state,
        parking: [...w.boxes.values()].some((b) => !b.dead && b.parking),
        dying: w.group.entries.some((e) => {
          const i = w.instances.get(e.id);
          return i !== undefined && i.state !== "running" && i.state !== "pending";
        }),
      },
    });
    control.invoke(
      "POST /v1/wake",
      (inv) => control.wake(inv),
      (answer) => {
        if (answer?.status === 202) {
          w.hooks.event({ type: "wake", at });
          const work = r.chance(0.7) ? r.int(0, 60 * MINUTE) : 0;
          for (let t = 0; t <= work; t += 5 * MINUTE) w.at(t, () => servingBox(w)?.activity(), "activity");
        } else if (attempt < 3) {
          w.at(20_000, () => wake(attempt + 1), "wake-retry");
        }
      },
    );
  };
  for (const at of cfg.wakes) w.at(at, () => wake(), "wake");

  // `dozebox park`: through the control function (R1: only the tick calls EC2). Under the W2 judge bug the CLI stops
  // things itself and leaves no record, as the legacy CLI did.
  const sleep = (): void => {
    w.log("person: sleep");
    if (cfg.bugs.includes("park-leaves-no-record")) {
      w.hooks.event({ type: "park", at: w.now, by: "user" });
      setDesired(w, 0, "user");
      const p = w.read("persistent", 0);
      if (p.state === "pending" || p.state === "running") stopPersistent(w, p.id, "user", "user");
      return;
    }
    control.invoke(
      "POST /v1/park",
      (inv) => control.park(inv, "user", "user", "user"),
      () => {},
    );
  };
  for (const at of cfg.userSleeps) w.at(at, sleep, "person-sleep");

  const reclaimRunning = (): void => {
    const target = [...w.instances.values()].find((i) => i.state === "running" && i.lifecycle === "spot");
    if (target) reclaim(w, target.id, r.chance(0.4));
  };
  for (const at of cfg.reclaims) w.at(at, reclaimRunning, "reclaim");
  const previousRunning = w.hooks.running;
  w.hooks.running = (inst) => {
    previousRunning(inst);
    if (inst.lifecycle === "spot" && w.now < EPOCH + cfg.horizonMs - cfg.settleMs && r.chance(cfg.reclaimOnRunningP)) {
      w.at(
        r.int(20_000, 30 * MINUTE),
        () => {
          if (inst.state === "running") reclaim(w, inst.id, r.chance(0.4));
        },
        "reclaim-after-start",
      );
    }
  };
  // A person who just got a reclaim notice often sleeps the box a few minutes later (W2).
  const previousEvent = w.hooks.event;
  w.hooks.event = (e) => {
    previousEvent(e);
    if (e.type === "notice" && r.chance(cfg.sleepAfterReclaimP))
      w.at(r.int(10_000, 12 * MINUTE), sleep, "sleep-after-reclaim");
  };

  for (const at of cfg.serverFaults) {
    w.at(
      at,
      () => {
        const box = servingBox(w);
        if (!box) return;
        w.hooks.event({ type: "disruption", what: "server" });
        if (r.chance(0.35)) box.crashServer();
        else box.hang(r.int(2 * MINUTE, 40 * MINUTE), r.chance(0.3));
      },
      "server-fault",
    );
  }

  // The data volume tagged `active=false` (the D-E drill), healed later. move-az tags only while the box sleeps.
  for (const [from, to] of cfg.tagWindows) {
    const retag = (): void => {
      if (w.billing().length > 0) {
        w.at(5 * MINUTE, retag, "tag-false");
        return;
      }
      (w.volumes[0] as { active: boolean }).active = false;
      w.touch();
      w.log("volume tagged active=false");
    };
    w.at(from, retag, "tag-false");
    w.at(
      to,
      () => {
        (w.volumes[0] as { active: boolean }).active = true;
        w.touch();
        w.log("volume tagged active=true");
      },
      "tag-true",
    );
  }
  for (const [from, to] of cfg.capacityWindows) {
    w.at(
      from,
      () => {
        w.hooks.event({ type: "disruption", what: "capacity" });
        w.log("Spot capacity out");
      },
      "capacity-out",
    );
    w.at(to, () => w.hooks.event({ type: "capacity-back" }), "capacity-back");
  }
}
