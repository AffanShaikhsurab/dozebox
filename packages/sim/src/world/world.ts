// The world (port of legacy sim/world.mjs): the clock plus a fake EC2, Auto Scaling group, EBS volume, a parameter
// store and EventBridge, whose behaviour comes only from MEASURED. Truth lives in the fields below; the control model
// and the agent read it through `read(key, lag)`, which can return the state as it was `lag` ms ago.
import { draw, MEASURED as M, type Span } from "../measured.ts";
import type { Rng } from "../prng.ts";
import type { SimConfig } from "../config.ts";
import { Clock, EPOCH, HOUR } from "./clock.ts";

type Ec2State = "pending" | "running" | "stopping" | "stopped" | "shutting-down" | "terminated";
export type Notice = { readonly at: number; readonly stopAt: number };

export type Instance = {
  readonly id: string;
  readonly kind: "persistent" | "group";
  readonly lifecycle: "spot" | "on-demand";
  readonly az: string;
  state: Ec2State;
  launchedAt: number;
  startedAt: number | null;
  stoppingAt: number | null;
  stoppedBy: "user" | "ec2" | null;
  notice: Notice | null;
  fis: boolean;
};

export type SpotRequest = { state: "active" | "disabled"; statusCode: string; statusUpdatedAt: number };
type Attachment = { readonly instanceId: string; state: "attaching" | "attached" | "detaching" };
export type Volume = { readonly id: string; readonly az: string; active: boolean; attachments: Attachment[] };
export type GroupEntry = { readonly id: string; lifecycleState: "Pending" | "InService" | "Terminating" };
export type Group = { desired: number; onDemandPercent: number; entries: GroupEntry[]; launching: boolean };

/** What the agent of one instance exposes to the world and the invariants. */
export type BoxHandle = {
  readonly inst: Instance;
  readonly bootedAt: number;
  readonly dead: boolean;
  readonly mounted: boolean;
  readonly everServed: boolean;
  readonly parking: boolean;
  /** Set when this boot gave up: `killed` when a process died mid-boot without writing an error. */
  readonly bootFailure: { readonly killed: boolean } | null;
  unwellSince: number | undefined;
  unwellEnd: number | undefined;
  readonly healthy: () => boolean;
  readonly serving: () => boolean;
  /** A payload hold is live (protocol mode): the idle rule does not apply. */
  readonly held: () => boolean;
  readonly kill: (reason: string) => void;
  readonly onVolumeAttached: () => void;
  readonly setNotice: (n: Notice) => void;
  readonly activity: () => void;
  readonly crashServer: () => void;
  readonly hang: (ms: number, sticky: boolean) => void;
};

export type Action =
  | {
      readonly type: "detach";
      readonly actor: string;
      readonly volumeId: string;
      readonly instanceId: string;
      readonly instanceState: Ec2State | undefined;
      readonly startedAt: number | null;
    }
  | { readonly type: "stop"; readonly actor: string; readonly id: string; readonly holdsVolume: boolean }
  | {
      readonly type: "attach";
      readonly actor: string;
      readonly volumeId: string;
      readonly instanceId: string;
      readonly active: boolean;
    }
  | { readonly type: "setDesired"; readonly n: number; readonly actor: string; readonly groupHoldsVolume: boolean }
  | { readonly type: "start"; readonly actor: string; readonly id: string }
  | { readonly type: "launch"; readonly actor: string; readonly id: string };

export type WorldEvent =
  | { readonly type: "wake-request"; readonly at: number; readonly truth: WakeTruth }
  | { readonly type: "wake"; readonly at: number }
  /** A park took effect in the state (`desired = asleep` written), or, under a judge bug, a direct stop. */
  | { readonly type: "park"; readonly at: number; readonly by: "user" | "agent" | "judge" }
  | { readonly type: "notice"; readonly id: string; readonly at: number }
  | { readonly type: "disruption"; readonly what: "server" | "capacity" }
  | { readonly type: "capacity-back" };

export type WakeTruth = {
  readonly persistent: Ec2State;
  readonly request: SpotRequest["state"];
  readonly parking: boolean;
  readonly dying: boolean;
};

/** The control invocation whose effect runs right now (for the invariants' classes). */
export type Invocation = { readonly id: number; readonly label: string; readonly startedAt: number };

export type Ec2Event =
  { readonly kind: "warning"; readonly instanceId: string } | { readonly kind: "stopped"; readonly instanceId: string };

export type Views = {
  readonly persistent: {
    readonly id: string;
    readonly state: Ec2State;
    readonly launchedAt: number;
    readonly stoppingAt: number | null;
    readonly stoppedBy: "user" | "ec2" | null;
  };
  readonly spot: SpotRequest;
  readonly volume: {
    readonly id: string;
    readonly attachedTo: string | null;
    readonly attachment: Attachment["state"] | null;
    readonly active: boolean;
  };
  readonly group: {
    readonly desired: number;
    readonly instances: ReadonlyArray<{ readonly id: string; readonly state: Ec2State; readonly launchedAt: number }>;
  };
};

type Snapshot = { readonly t: number; readonly views: Views };

export type Hooks = {
  action: (a: Action) => void;
  running: (inst: Instance) => void;
  down: (inst: Instance) => void;
  event: (e: WorldEvent) => void;
  ec2Event: (e: Ec2Event) => void;
};

export class World extends Clock {
  readonly rng: Rng;
  readonly cfg: SimConfig;
  readonly r: Rng;
  readonly instances = new Map<string, Instance>();
  readonly boxes = new Map<string, BoxHandle>();
  readonly alerts: Array<{ readonly at: number; readonly text: string }> = [];
  readonly boxKills: Array<{ readonly at: number; readonly name: string; readonly instanceId: string }> = [];
  /** Times an instance was told to stop or terminate. */
  readonly stopTraces: number[] = [];
  readonly groupTraces: number[] = [];
  /** Every write of `desired = awake`: when and by which invocation. */
  readonly intentWrites: Array<{ readonly at: number; readonly by: number | null }> = [];
  lastActivity = Number.NEGATIVE_INFINITY;
  current: Invocation | null = null;
  readonly persistent: Instance;
  spot: SpotRequest;
  readonly volumes: Volume[];
  readonly group: Group = { desired: 0, onDemandPercent: 0, entries: [], launching: false };
  hooks: Hooks = { action: () => {}, running: () => {}, down: () => {}, event: () => {}, ec2Event: () => {} };
  private readonly history: Snapshot[] = [];
  private ids = 0;

  constructor(rng: Rng, cfg: SimConfig) {
    super();
    this.rng = rng;
    this.cfg = cfg;
    this.r = rng.fork("world");
    this.persistent = {
      id: "i-0persist0000001",
      kind: "persistent",
      lifecycle: "spot",
      az: "us-east-1a",
      state: "stopped",
      launchedAt: EPOCH - 6 * HOUR,
      startedAt: null,
      stoppingAt: null,
      stoppedBy: "user",
      notice: null,
      fis: false,
    };
    this.instances.set(this.persistent.id, this.persistent);
    this.spot = { state: "disabled", statusCode: "instance-stopped-by-user", statusUpdatedAt: EPOCH - 6 * HOUR };
    this.volumes = [
      {
        id: "vol-0data0000001",
        az: "us-east-1a",
        active: true,
        attachments: [{ instanceId: this.persistent.id, state: "attached" }],
      },
    ];
    this.history.push({ t: Number.NEGATIVE_INFINITY, views: this.views() });
  }

  nextId(prefix: string): string {
    return `${prefix}-${(0x1a2b3c4d + (this.ids += 1) * 7919).toString(16).padStart(8, "0")}`;
  }

  draw(span: Span): number {
    return draw(this.r, span);
  }

  chance(p: number): boolean {
    return this.r.chance(p);
  }

  views(): Views {
    const p = this.persistent;
    const data = this.volumes[0] as Volume;
    const held = data.attachments.find((a) => a.state === "attached" || a.state === "attaching");
    return {
      persistent: {
        id: p.id,
        state: p.state,
        launchedAt: p.launchedAt,
        stoppingAt: p.stoppingAt,
        stoppedBy: p.stoppedBy,
      },
      spot: { ...this.spot },
      volume: {
        id: data.id,
        attachedTo: held?.instanceId ?? null,
        attachment: data.attachments[0]?.state ?? null,
        active: data.active,
      },
      group: {
        desired: this.group.desired,
        instances: this.group.entries.map((e) => {
          const i = this.instances.get(e.id);
          return { id: e.id, state: i?.state ?? "terminated", launchedAt: i?.launchedAt ?? 0 };
        }),
      },
    };
  }

  /** Record the truth after a change, so stale reads can see the past. */
  touch(): void {
    this.history.push({ t: this.now, views: this.views() });
    const cutoff = this.now - M.staleTailMaxMs * 2;
    while (this.history.length > 2 && (this.history[1] as Snapshot).t < cutoff) this.history.shift();
  }

  /** The state as the API shows it: `lag` ms behind the truth. */
  read<K extends keyof Views>(key: K, lag = 0): Views[K] {
    if (lag <= 0) return this.views()[key];
    const target = this.now - lag;
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const h = this.history[i] as Snapshot;
      if (h.t <= target) return h.views[key];
    }
    return (this.history[0] as Snapshot).views[key];
  }

  staleLag(r: Rng): number {
    if (!(this.cfg.staleP > 0 && r.chance(this.cfg.staleP))) return 0;
    return r.chance(M.staleTailP) ? r.int(this.cfg.staleMaxMs, M.staleTailMaxMs) : r.int(1000, this.cfg.staleMaxMs);
  }

  capacityOut(): boolean {
    return this.cfg.capacityWindows.some(([from, to]) => this.now >= EPOCH + from && this.now < EPOCH + to);
  }

  /** An EC2 event through EventBridge: delayed, and sometimes dropped, late or duplicated. */
  emit(e: Ec2Event, delay: Span): void {
    if (this.r.chance(this.cfg.eventDropP)) {
      this.log(`event lost: ${e.kind} ${e.instanceId}`);
      return;
    }
    const copies = this.r.chance(this.cfg.eventDupP) ? 2 : 1;
    for (let i = 0; i < copies; i += 1) {
      const late = this.r.chance(this.cfg.eventLateP) ? this.r.int(5_000, 90_000) : 0;
      this.at(this.draw(delay) + late, () => this.hooks.ec2Event(e), "event");
    }
  }

  billing(): Instance[] {
    return [...this.instances.values()].filter(
      (i) => i.state === "pending" || i.state === "running" || i.state === "stopping",
    );
  }

  liveGroup(): GroupEntry[] {
    return this.group.entries.filter((e) => e.lifecycleState === "Pending" || e.lifecycleState === "InService");
  }

  groupHoldsVolume(): boolean {
    return this.volumes.some((v) =>
      v.attachments.some((a) => this.instances.get(a.instanceId)?.kind === "group" && a.state !== "detaching"),
    );
  }

  holdsVolume(id: string): boolean {
    return this.volumes.some((v) => v.attachments.some((a) => a.instanceId === id && a.state !== "detaching"));
  }
}
