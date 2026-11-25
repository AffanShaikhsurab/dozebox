// How a sleep was undone and why a wake is unresolved, decided from the world's truth (port of the legacy classes).
import { MINUTE } from "../world/clock.ts";
import type { WakeTruth, World } from "../world/world.ts";

export type Memory = {
  lastWake: number;
  lastPark: number;
  lastNotice: number;
  lastServing: number;
  readonly wakeTruth: Map<number, WakeTruth>;
};

/**
 *   raced-with-sleep      an invocation in flight at the sleep undid it, or wrote the intent that did
 *   late-event            a reclaim event delivered after the sleep still launched a replacement
 *   ec2-stop-replacing    EC2 stopped the persistent instance a few minutes ago, and the fallback is relaunched
 *   sleep-left-no-trace   the sleep stopped nothing, so the next tick still reads the wake intent
 *   sleep-before-successor-launched  the sleep came right after a reclaim warning, before the group had an instance
 *   intent-before-sleep   the sleep stopped an instance and the older intent still wins (W2)
 */
export function undoClass(w: World, m: Memory): string {
  if (w.current !== null && w.current.startedAt < m.lastPark) return "raced-with-sleep";
  if (w.intentWrites.some((write) => Math.abs(write.at - m.lastPark) <= 3000)) return "raced-with-sleep";
  if (w.current?.label.startsWith("ec2:")) return "late-event";
  const p = w.persistent;
  if (p.stoppedBy === "ec2" && p.stoppingAt !== null && w.now - p.stoppingAt < 18 * MINUTE) return "ec2-stop-replacing";
  if (!w.stopTraces.some((t) => t >= m.lastPark - 1000 && t <= m.lastPark + 5000)) return "sleep-left-no-trace";
  if (
    !w.groupTraces.some((t) => t >= m.lastPark - 1000 && t <= m.lastPark + 5000) &&
    m.lastPark - m.lastNotice < 5 * MINUTE
  )
    return "sleep-before-successor-launched";
  const prior = w.intentWrites.filter((write) => write.by !== w.current?.id).at(-1);
  if (prior && prior.at > m.lastPark) return "raced-with-sleep";
  return "intent-before-sleep";
}

/**
 *   fallback-boot-failed / persistent-boot-failed  an instance is up and its boot was refused (stale volume tag): D-E
 *   boot-killed/replacement-after-serve  an agent process was killed mid-boot on an instance that replaced a serving one
 *   boot-killed/fresh-boot  the same on a boot that follows no serve
 *   boot-failed-then-parked, wake-onto-dying-instance, wake-during-park, wake-during-stop, no-instance, up-not-serving
 */
export function unresolvedClass(w: World, m: Memory, at: number): string {
  const boxes = [...w.boxes.values()];
  const up = boxes.filter((b) => !b.dead && (b.inst.state === "pending" || b.inst.state === "running"));
  const refused = up.find((b) => b.bootFailure !== null && !b.bootFailure.killed);
  if (refused) return refused.inst.kind === "group" ? "fallback-boot-failed" : "persistent-boot-failed";
  const killed = up.find((b) => b.bootFailure?.killed === true);
  if (killed)
    return Number.isFinite(m.lastServing) &&
      m.lastServing < killed.inst.launchedAt &&
      killed.inst.launchedAt - m.lastServing < 90 * MINUTE
      ? "boot-killed/replacement-after-serve"
      : "boot-killed/fresh-boot";
  if (boxes.some((b) => b.bootFailure !== null && !b.bootFailure.killed && b.inst.launchedAt >= at - 60_000))
    return "boot-failed-then-parked";
  const truth = m.wakeTruth.get(at);
  if (truth?.dying) return "wake-onto-dying-instance";
  if (truth?.parking) return "wake-during-park";
  if (truth && (truth.persistent === "stopping" || (truth.persistent === "stopped" && truth.request !== "disabled")))
    return "wake-during-stop";
  return up.length === 0 ? "no-instance" : "up-not-serving";
}
