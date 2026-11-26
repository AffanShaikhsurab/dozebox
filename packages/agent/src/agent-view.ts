// What the agent tells payloads (`GET /v1/status`, part 4 §4.11) and the control function (`rec/liveness`, §4.14),
// built from the shared agent state. Pure functions over a snapshot, so the wiring in agent-loops.ts stays thin.
import type { IdleVerdict } from "@dozebox/core/idle";
import type { RecordTypes } from "@dozebox/core/records";
import { toInstant } from "@dozebox/core/time";
import type { PayloadDefinition } from "@dozebox/protocol/payload";
import type { Status } from "@dozebox/protocol/v1";
import type { BoxAlert } from "./alerts/index.ts";
import type { DiskReading } from "./disk/index.ts";
import type { Identity } from "./identity.ts";
import type { JailReadiness } from "./jail/index.ts";
import type { NetState } from "./net/index.ts";
import type { AgentPhase } from "./phase.ts";
import type { HealthResult } from "./ports/payloads.ts";
import type { ProtocolStore } from "./protocol/index.ts";

export type AgentView = {
  readonly identity: Identity;
  readonly bootedAt: number;
  readonly phase: AgentPhase;
  readonly verdict: IdleVerdict | null;
  readonly disk: DiskReading | null;
  readonly jail: JailReadiness;
  readonly memoryBytes: number;
  readonly cpus: number;
  readonly awakeSecondsCap: number | null;
};

const instantOrNull = (ms: number | null): string | null => (ms === null || ms <= 0 ? null : toInstant(ms));

export function buildStatus(v: AgentView, store: ProtocolStore, payload: string | null, now: number): Status {
  const p = v.phase;
  const idle = v.verdict;
  return {
    box: {
      id: v.identity.boxId,
      phase: p.phase,
      since: toInstant(p.since),
      instance: {
        id: v.identity.instanceId,
        type: v.identity.instanceType,
        az: v.identity.availabilityZone,
        lifecycle: v.identity.lifecycle,
      },
      bootedAt: toInstant(v.bootedAt),
      ...(p.phase === "reclaim-notice" ? { terminationAt: toInstant(p.terminationAt) } : {}),
      memoryBytes: v.memoryBytes,
      cpus: v.cpus,
      controlUrl: null,
    },
    jail: { ready: v.jail.ready, egress: v.jail.egress, missing: [...v.jail.missing] },
    idle: {
      since: idle?.kind === "idle" ? instantOrNull(idle.since) : null,
      sleepAt: idle?.kind === "idle" ? toInstant(idle.sleepAt) : null,
      awakeBecause: idle?.kind === "awake" ? [...idle.because] : [],
    },
    disk: {
      level: v.disk?.level ?? "ok",
      freePct: v.disk?.freePct ?? 100,
      freeBytes: 0,
      at: toInstant(now),
    },
    caps: { awakeSecondsToday: Math.max(0, Math.round((now - v.bootedAt) / 1000)), awakeSecondsCap: v.awakeSecondsCap },
    holds: [...store.listHolds(payload, now)],
    wakes: [...store.listWakes(payload, now)],
  };
}

type Liveness = Omit<RecordTypes["rec/liveness"], "v" | "at" | "writer">;

export type LivenessFacts = {
  readonly version: string;
  readonly strikes: number;
  readonly payloads: ReadonlyArray<PayloadDefinition>;
  readonly health: ReadonlyArray<HealthResult>;
  readonly served: boolean;
  readonly interactiveUntil: number | null;
  readonly lastInteractiveAt: number | null;
  readonly verdict: IdleVerdict | null;
  readonly net: NetState | null;
  readonly netDownSince: number | null;
  readonly disk: DiskReading | null;
  readonly undelivered: ReadonlyArray<BoxAlert>;
};

export function buildLiveness(f: LivenessFacts, store: ProtocolStore, now: number): Liveness {
  return {
    agent: { version: f.version, ok: true, strikes: f.strikes },
    payloads: f.payloads.slice(0, 4).map((d) => {
      const h = f.health.find((r) => r.name === d.name);
      const beats = store.beatsOf(d.name, now);
      const progress = Object.entries(beats.progress)
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 8);
      const holds = store.listHolds(d.name, now);
      const until = holds.reduce<string | null>((m, x) => (m === null || x.until > m ? x.until : m), null);
      return {
        name: d.name,
        health: h ? (h.ok ? "ok" : f.served ? "failing" : "starting") : "unknown",
        ...(h ? { healthDetail: h.detail.slice(0, 200) } : {}),
        restartsThisHour: 0,
        lastProgressAt: progress[0] ? toInstant(progress[0][1]) : null,
        progress: Object.fromEntries(progress.map(([k, at]) => [k, toInstant(at)])),
        holds: {
          work: holds.filter((x) => x.kind === "work").length,
          wait: holds.filter((x) => x.kind === "wait").length,
          until,
          reasons: holds.slice(0, 5).map((x) => x.reason),
        },
      };
    }),
    presence: {
      interactiveUntil: instantOrNull(f.interactiveUntil),
      lastInteractiveAt: instantOrNull(f.lastInteractiveAt),
    },
    idle: {
      since: f.verdict?.kind === "idle" ? instantOrNull(f.verdict.since) : null,
      sleepAt: f.verdict?.kind === "idle" ? toInstant(f.verdict.sleepAt) : null,
    },
    net: { ok: (f.net?.strikes ?? 0) === 0, downSince: instantOrNull(f.netDownSince) },
    disk: { level: f.disk?.level ?? "ok", freePct: Math.round((f.disk?.freePct ?? 100) * 10) / 10 },
    undelivered: f.undelivered.slice(-5).map((a) => ({
      key: a.source,
      severity: a.severity,
      title: a.title.slice(0, 120),
      at: toInstant(a.at),
    })),
  };
}
