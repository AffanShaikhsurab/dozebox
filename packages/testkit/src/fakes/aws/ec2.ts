// FakeAws EC2: instances whose state is a timeline, so a describe can be read "N seconds stale" like the real
// eventually consistent API, and Spot request states move the way a persistent stop-behaviour request moves.
import type { Compute, MachineState, MachineView } from "@dozebox/control/ports/compute";
import { awsError, type Faults, type Now, type Tags } from "./world.ts";

export type FakeEc2Timing = {
  /** pending -> running after a start or launch. */
  readonly bootMs: number;
  /** stopping -> stopped, and shutting-down -> terminated. */
  readonly stopMs: number;
  /** After a Spot machine stops, its request stays `marked-for-stop` this long before `disabled`. */
  readonly spotSettleMs: number;
};

export const DEFAULT_EC2_TIMING: FakeEc2Timing = { bootMs: 30_000, stopMs: 60_000, spotSettleMs: 10_000 };

type Frame = Omit<MachineView, "id"> & { readonly at: number };

type Instance = {
  readonly id: string;
  readonly zone: string;
  readonly lifecycle: "spot" | "on-demand";
  readonly tags: Map<string, string>;
  readonly frames: Frame[];
};

type AddMachine = {
  readonly boxId: string;
  readonly role: "persistent" | "group";
  readonly state: "running" | "stopped";
  readonly lifecycle: "spot" | "on-demand";
  readonly zone?: string;
};

export type FakeEc2 = {
  readonly compute: Pick<Compute, "describePersistent" | "startPersistent" | "stopPersistent">;
  /** Seed a machine tagged like the module tags it. Returns its id. */
  readonly addMachine: (m: AddMachine) => string;
  /** Describes (and group describes) return the state as of `ms` ago. 0 is a fresh read. */
  readonly setStaleness: (ms: number) => void;
  /** With false, starting a stopped Spot machine fails with InsufficientInstanceCapacity. */
  readonly setSpotCapacity: (available: boolean) => void;
  /** The current truth, ignoring staleness. */
  readonly machine: (id: string) => MachineView | null;
  readonly zoneOf: (id: string) => string | null;
  /** Every start and stop call that reached the fake, with its token. */
  readonly calls: ReadonlyArray<{ readonly op: "start" | "stop"; readonly id: string; readonly token: string }>;
  /** Group support: launch a machine, terminate one, read one as of the stale time. */
  readonly launch: (m: Omit<AddMachine, "state">) => string;
  readonly terminate: (id: string) => void;
  readonly staleView: (id: string) => MachineView | null;
};

const LIVE: ReadonlySet<MachineState> = new Set(["pending", "running", "stopping", "stopped"]);

export function makeFakeEc2(deps: {
  readonly clock: Now;
  readonly faults: Faults;
  readonly tags: Tags;
  readonly newId: () => string;
  readonly timing: FakeEc2Timing;
}): FakeEc2 {
  const { clock, faults, tags, timing } = deps;
  const instances = new Map<string, Instance>();
  const calls: Array<{ op: "start" | "stop"; id: string; token: string }> = [];
  let staleMs = 0;
  let spotCapacity = true;

  const frameAt = (inst: Instance, t: number): Frame | null => {
    let found: Frame | null = null;
    for (const f of inst.frames) if (f.at <= t) found = f;
    return found;
  };
  const viewAt = (inst: Instance, t: number): MachineView | null => {
    const f = frameAt(inst, t);
    if (!f) return null;
    const { at: _at, ...rest } = f;
    return { id: inst.id, ...rest };
  };
  /** Drop what was scheduled after now, then schedule `next`. */
  const schedule = (inst: Instance, next: ReadonlyArray<Frame>): void => {
    const now = clock.now();
    for (let i = inst.frames.length - 1; i >= 0; i--) if ((inst.frames[i]?.at ?? 0) > now) inst.frames.splice(i, 1);
    inst.frames.push(...next);
  };
  const get = (id: string): Instance => {
    const inst = instances.get(id);
    if (!inst) throw awsError("InvalidInstanceID.NotFound", `The instance ID '${id}' does not exist`);
    return inst;
  };
  const spotIdle = (inst: Instance): MachineView["spotRequest"] => (inst.lifecycle === "spot" ? "active" : "none");

  const create = (m: AddMachine): string => {
    const id = deps.newId();
    const now = clock.now();
    const inst: Instance = {
      id,
      zone: m.zone ?? "us-east-1a",
      lifecycle: m.lifecycle,
      tags: new Map([
        [tags.box, m.boxId],
        [tags.role, m.role],
      ]),
      frames: [],
    };
    const spot = m.lifecycle === "spot";
    inst.frames.push(
      m.state === "running"
        ? {
            at: now,
            state: "running",
            lifecycle: m.lifecycle,
            launchedAt: now,
            stoppingAt: null,
            spotRequest: spotIdle(inst),
          }
        : {
            at: now,
            state: "stopped",
            lifecycle: m.lifecycle,
            launchedAt: now,
            stoppingAt: now,
            spotRequest: spot ? "disabled" : "none",
          },
    );
    instances.set(id, inst);
    return id;
  };

  const start = (inst: Instance): void => {
    const now = clock.now();
    const cur = viewAt(inst, now);
    switch (cur?.state) {
      case "pending":
      case "running":
        return;
      case "stopped":
        break;
      default:
        throw awsError(
          "IncorrectInstanceState",
          `The instance '${inst.id}' is not in a state from which it can be started.`,
        );
    }
    if (inst.lifecycle === "spot") {
      if (cur.spotRequest === "marked-for-stop") {
        throw awsError("IncorrectSpotRequestState", `The Spot request for '${inst.id}' is still marked-for-stop.`);
      }
      if (!spotCapacity) throw awsError("InsufficientInstanceCapacity", "There is no Spot capacity available.", 500);
    }
    const base = { lifecycle: inst.lifecycle, launchedAt: now, stoppingAt: null, spotRequest: spotIdle(inst) } as const;
    schedule(inst, [
      { at: now, state: "pending", ...base },
      { at: now + timing.bootMs, state: "running", ...base },
    ]);
  };

  const stop = (inst: Instance): void => {
    const now = clock.now();
    const cur = viewAt(inst, now);
    switch (cur?.state) {
      case "stopping":
      case "stopped":
        return;
      case "running":
        break;
      default:
        throw awsError(
          "IncorrectInstanceState",
          `The instance '${inst.id}' is not in a state from which it can be stopped.`,
        );
    }
    const spot = inst.lifecycle === "spot";
    // AWS reports the stop time in StateTransitionReason with one-second resolution.
    const stoppingAt = Math.floor(now / 1000) * 1000;
    const base = { lifecycle: inst.lifecycle, launchedAt: cur.launchedAt, stoppingAt } as const;
    const marked = spot ? "marked-for-stop" : "none";
    const frames: Frame[] = [
      { at: now, state: "stopping", ...base, spotRequest: marked },
      { at: now + timing.stopMs, state: "stopped", ...base, spotRequest: marked },
    ];
    if (spot)
      frames.push({
        at: now + timing.stopMs + timing.spotSettleMs,
        state: "stopped",
        ...base,
        spotRequest: "disabled",
      });
    schedule(inst, frames);
  };

  const persistentOf = (boxId: string, t: number): MachineView | null => {
    const views = [...instances.values()]
      .filter((i) => i.tags.get(tags.box) === boxId && i.tags.get(tags.role) === "persistent")
      .map((i) => viewAt(i, t))
      .filter((v): v is MachineView => v !== null)
      .toSorted((a, b) => b.launchedAt - a.launchedAt);
    return views.find((v) => LIVE.has(v.state)) ?? views[0] ?? null;
  };

  return {
    compute: {
      describePersistent: async (boxId) => {
        faults.check("ec2.describe");
        return persistentOf(boxId, clock.now() - staleMs);
      },
      startPersistent: async (id, token) => {
        faults.check("ec2.start");
        const inst = get(id);
        calls.push({ op: "start", id, token });
        start(inst);
      },
      stopPersistent: async (id, token) => {
        faults.check("ec2.stop");
        const inst = get(id);
        calls.push({ op: "stop", id, token });
        stop(inst);
      },
    },
    addMachine: create,
    setStaleness: (ms) => {
      staleMs = ms;
    },
    setSpotCapacity: (available) => {
      spotCapacity = available;
    },
    machine: (id) => {
      const inst = instances.get(id);
      return inst ? viewAt(inst, clock.now()) : null;
    },
    zoneOf: (id) => instances.get(id)?.zone ?? null,
    calls,
    launch: (m) => {
      const id = create({ ...m, state: "running" });
      const inst = get(id);
      const now = clock.now();
      const base = { lifecycle: m.lifecycle, launchedAt: now, stoppingAt: null, spotRequest: spotIdle(inst) } as const;
      inst.frames.splice(
        0,
        inst.frames.length,
        { at: now, state: "pending", ...base },
        { at: now + timing.bootMs, state: "running", ...base },
      );
      return id;
    },
    terminate: (id) => {
      const inst = get(id);
      const now = clock.now();
      const cur = viewAt(inst, now);
      if (!cur || cur.state === "shutting-down" || cur.state === "terminated") return;
      const { id: _id, ...rest } = cur;
      schedule(inst, [
        { ...rest, at: now, state: "shutting-down" },
        { ...rest, at: now + timing.stopMs, state: "terminated" },
      ]);
    },
    staleView: (id) => {
      const inst = instances.get(id);
      return inst ? viewAt(inst, clock.now() - staleMs) : null;
    },
  };
}
