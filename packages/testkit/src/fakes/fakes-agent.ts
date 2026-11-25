// Fakes for the agent lanes' ports: holds (A2 -> A5), payload units (A3 -> A5, A8), Spot notices and host stats (A6),
// presence sources (A2). Simple in-memory state the test sets directly.
import type { IdleHold, IdlePresence } from "@dozebox/core/idle";
import type { BoxWakeRequests, HoldSource } from "@dozebox/agent/ports/holds";
import type { FsSpace, HostStats, SpotAction, SpotNotices } from "@dozebox/agent/ports/host";
import type { HealthResult, PayloadSupervisor, PayloadUnitState } from "@dozebox/agent/ports/payloads";
import type { PresenceSample, PresenceSource } from "@dozebox/agent/ports/presence";

export type FakeHolds = HoldSource & {
  holdList: IdleHold[];
  presenceList: IdlePresence[];
  progressAt: number | null;
  interactiveAt: number | null;
  wakes: BoxWakeRequests;
};

export function makeFakeHolds(): FakeHolds {
  const f: FakeHolds = {
    holdList: [],
    presenceList: [],
    progressAt: null,
    interactiveAt: null,
    wakes: [],
    holds: async (now) => f.holdList.filter((h) => h.until > now),
    presence: async (now) => f.presenceList.filter((p) => p.until > now),
    lastProgressAt: async () => f.progressAt,
    lastInteractiveAt: async () => f.interactiveAt,
    wakeRequests: async () => f.wakes,
  };
  return f;
}

export type FakeSupervisor = PayloadSupervisor & {
  readonly calls: ReadonlyArray<string>;
  units: PayloadUnitState[];
  health: HealthResult[];
};

export function makeFakeSupervisor(): FakeSupervisor {
  const calls: string[] = [];
  const f: FakeSupervisor = {
    calls,
    units: [],
    health: [],
    startAll: async () => {
      calls.push("startAll");
      f.units = f.units.map((u) => ({ ...u, active: "active" }));
    },
    stopAll: async () => {
      calls.push("stopAll");
      f.units = f.units.map((u) => ({ ...u, active: "inactive" }));
    },
    restart: async (name) => {
      calls.push(`restart:${name}`);
    },
    states: async () => f.units,
    checkHealth: async () => f.health,
  };
  return f;
}

export function makeFakeSpotNotices(): SpotNotices & { notice: SpotAction | null } {
  const f = { notice: null as SpotAction | null, instanceAction: async () => f.notice };
  return f;
}

export function makeFakeHostStats(): HostStats & {
  spaces: Map<string, FsSpace>;
  tx: number;
  reachable: Set<string>;
} {
  const f = {
    spaces: new Map<string, FsSpace>(),
    tx: 0,
    reachable: new Set<string>(),
    space: async (path: string) => f.spaces.get(path) ?? { totalBytes: 100, freeBytes: 100 },
    txBytes: async () => f.tx,
    reach: async (host: string) => f.reachable.has(host),
  };
  return f;
}

export function makeFakePresenceSource(id = "fake"): PresenceSource & { samples: PresenceSample[] } {
  const f = { id, samples: [] as PresenceSample[], sample: async () => f.samples };
  return f;
}
