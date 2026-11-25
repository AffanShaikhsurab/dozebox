// The six public states (part 5 §5.3) as a projection of what AWS and the records show, never stored (part 6 §6.3:
// a stored state is a second truth that drifts from EC2). Pure: facts in, state out. The rules follow the legacy
// `/status` (running wins; pending is launching; a fresh box error after the newest launch is stopped-error) on the
// typed facts of the reconciler: the desired state, the interruption record and the last start error.
import type { Desired } from "@dozebox/core/reconcile";
import { MINUTE } from "@dozebox/core/time";
import type { ControlState } from "@dozebox/protocol/control";
import type { MachineView } from "../ports/compute.ts";

/** A replacement after an interruption counts as `replacing` this long (REPLACING_WINDOW_MS of the reconciler). */
export const REPLACING_MS = 15 * MINUTE;
/** A group that has been asked for a machine this long and shows none is waiting for capacity (legacy rule). */
export const WAITING_CAPACITY_MS = 3 * MINUTE;

export type GroupFacts = {
  /** `spot`: the box's own group (group machine mode); `fallback`: the On-Demand fallback group. */
  readonly role: "spot" | "fallback";
  readonly desired: 0 | 1;
  readonly machines: ReadonlyArray<MachineView>;
};

export type ProjectFacts = {
  readonly now: number;
  readonly desired: Desired;
  readonly persistent: MachineView | null;
  readonly groups: ReadonlyArray<GroupFacts>;
  /** When the box last wrote rec/last-error (its own boot or payload failure). */
  readonly lastErrorAt: number | null;
  readonly interruption: { readonly instanceId: string; readonly at: number } | null;
  readonly lastStartError: { readonly at: number; readonly kind: "capacity" | "refused" | "other" } | null;
};

export type Projection = {
  readonly state: ControlState;
  /** Epoch ms the state began. */
  readonly since: number;
  readonly machine?: "persistent" | "fallback";
  /** The machine the state is about, when there is one. */
  readonly instance?: MachineView;
};

type Placed = { readonly m: MachineView; readonly machine: "persistent" | "fallback" | undefined };

const live = (m: MachineView): boolean => m.state === "pending" || m.state === "running";

export function projectState(f: ProjectFacts): Projection {
  const p = f.persistent;
  const placed: Placed[] = [
    ...(p === null ? [] : [{ m: p, machine: "persistent" as const }]),
    ...f.groups.flatMap((g) =>
      g.machines.map((m) => ({ m, machine: g.role === "fallback" ? ("fallback" as const) : undefined })),
    ),
  ];
  const at = (x: Placed, state: ControlState, since: number): Projection => ({
    state,
    since,
    ...(x.machine === undefined ? {} : { machine: x.machine }),
    instance: x.m,
  });

  const running = placed.find((x) => x.m.state === "running");
  if (running) return at(running, "running", running.m.launchedAt);
  const pending = placed.find((x) => x.m.state === "pending");
  if (pending) return at(pending, "launching", f.desired.want === "awake" ? f.desired.since : pending.m.launchedAt);

  // Nothing is up from here.
  const awake = f.desired.want === "awake";
  const newestLaunch = Math.max(0, ...placed.map((x) => x.m.launchedAt));
  const errorAt = f.lastErrorAt;
  if (errorAt !== null && errorAt >= newestLaunch && (!awake || errorAt >= f.desired.since)) {
    return { state: "stopped-error", since: errorAt, ...(p === null ? {} : { machine: "persistent" as const }) };
  }
  if (awake) {
    const i = f.interruption;
    const ours = i !== null && placed.some((x) => x.m.id === i.instanceId);
    if (i !== null && ours && i.at >= f.desired.since && f.now - i.at < REPLACING_MS) {
      return { state: "replacing", since: i.at, machine: "fallback" };
    }
    const e = f.lastStartError;
    const capacity = e !== null && e.kind === "capacity" && e.at >= f.desired.since;
    const asked = f.groups.some((g) => g.desired === 1 && !g.machines.some(live));
    const machine = p === null ? {} : { machine: "persistent" as const };
    if (capacity || (asked && f.now - f.desired.since >= WAITING_CAPACITY_MS)) {
      return { state: "waiting-capacity", since: f.desired.since, ...machine };
    }
    return { state: "launching", since: f.desired.since, ...machine };
  }
  const stoppedAt = p?.stoppingAt ?? 0;
  const since = Math.max(stoppedAt, f.desired.since) || newestLaunch || f.now;
  return { state: "parked", since, ...(p === null ? {} : { machine: "persistent" as const }) };
}
