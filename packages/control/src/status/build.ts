// The `ControlStatus` body (part 5 §5.3): gather the facts (one records read, the machine and group describes, the
// state table items), project the six-state view, and fill the optional blocks from the box's records. Only reads:
// the routes get a read-only view of Compute, so building a status can never start or stop anything.
import { RunnerError } from "@dozebox/core/errors";
import type { Desired } from "@dozebox/core/reconcile";
import { readRecord, type RecordName } from "@dozebox/core/records";
import { composeSummary } from "@dozebox/core/summary";
import { toInstant } from "@dozebox/core/time";
import type { ControlStatus } from "@dozebox/protocol/control";
import type { LastErrorRecord, LastWordsRecord, LivenessRecord } from "@dozebox/protocol/records";
import { relativeParameter, type ControlConfig } from "../config.ts";
import type { Compute, MachineView } from "../ports/compute.ts";
import type { RecordStore, StoredRecord } from "../ports/records.ts";
import type { StateTable } from "../ports/state.ts";
import type { DesiredStore } from "../state/desired.ts";
import { CapsView, Interruption, KEYS, LastStartError, readKey } from "../state/keys.ts";
import { projectState, type GroupFacts, type Projection } from "./project.ts";

/** What the HTTP routes may call on Compute: describes only. */
export type ComputeReader = Pick<Compute, "describePersistent" | "describeGroup">;

export type StatusDeps = {
  readonly config: ControlConfig;
  readonly compute: ComputeReader;
  readonly records: RecordStore;
  readonly state: StateTable;
  readonly desired: DesiredStore;
};

type Freeze = { readonly frozen: boolean; readonly by: string | null };

export type StatusFacts = {
  readonly now: number;
  readonly desired: Desired;
  readonly freeze: Freeze;
  readonly persistent: MachineView | null;
  readonly groups: ReadonlyArray<GroupFacts>;
  readonly records: ReadonlyMap<string, StoredRecord>;
  readonly interruption: Interruption | null;
  readonly lastStartError: LastStartError | null;
  readonly caps: CapsView | null;
};

/** The freeze record the kill runbook writes (`{"v":1,"frozen":true,"by":"kill","reason":...}`); unfreeze deletes it. */
function readFreeze(raw: string | undefined): Freeze {
  if (raw === undefined) return { frozen: false, by: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // An unreadable freeze record still freezes: failing closed is the safe side of a kill switch.
    return { frozen: true, by: null };
  }
  const v = typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};
  if (v["frozen"] === false) return { frozen: false, by: null };
  const reason = typeof v["reason"] === "string" ? v["reason"] : typeof v["by"] === "string" ? v["by"] : null;
  return { frozen: true, by: reason };
}

async function describeGroup(compute: ComputeReader, name: string | null, role: GroupFacts["role"]) {
  if (name === null) return null;
  try {
    const g = await compute.describeGroup(name);
    return { role, desired: g.desired, machines: g.machines };
  } catch (e) {
    if (e instanceof RunnerError && e.code === "aws_not_found") return null;
    throw e;
  }
}

export async function gatherFacts(deps: StatusDeps, now: number): Promise<StatusFacts> {
  const { config: cfg } = deps;
  const [records, persistent, spot, fallback, desired, interruption, lastStartError, caps] = await Promise.all([
    deps.records.readAll(),
    deps.compute.describePersistent(cfg.box.id),
    describeGroup(deps.compute, cfg.groups.spot, "spot"),
    describeGroup(deps.compute, cfg.groups.fallback, "fallback"),
    deps.desired.read(),
    readKey(deps.state, KEYS.interruption, Interruption),
    readKey(deps.state, KEYS.lastStartError, LastStartError),
    readKey(deps.state, KEYS.caps, CapsView),
  ]);
  const byName = new Map(records.map((r) => [r.name, r]));
  return {
    now,
    desired,
    freeze: readFreeze(byName.get(relativeParameter(cfg, cfg.kill.freezeParameter))?.value),
    persistent,
    groups: [spot, fallback].filter((g): g is GroupFacts => g !== null),
    records: byName,
    interruption,
    lastStartError,
    caps,
  };
}

/** A box record that parses at its known version, else null. */
function record<N extends RecordName>(facts: StatusFacts, name: N) {
  const r = readRecord(name, facts.records.get(name)?.value ?? null, null);
  return r.kind === "ok" ? r.record : null;
}

/** True when `r` was written by machine `m` during its current run. */
const thisRun = (r: { readonly at: string; readonly writer: { readonly instanceId: string } }, m: MachineView) =>
  r.writer.instanceId === m.id && Date.parse(r.at) >= m.launchedAt;

const hours = (minutes: number): number => Math.round((minutes / 60) * 10) / 10;

function liveness(r: LivenessRecord): NonNullable<ControlStatus["liveness"]> {
  return {
    at: r.at,
    payloads: r.payloads.map((p) => ({ name: p.name, health: p.health, lastProgressAt: p.lastProgressAt })),
    idleSleepAt: r.idle.sleepAt,
    awakeBecause: r.payloads.flatMap((p) => p.holds.reasons),
  };
}

function boxBlocks(facts: StatusFacts, view: Projection): Partial<ControlStatus> {
  const m = view.instance;
  if (view.state === "running" && m !== undefined) {
    const serving = record(facts, "rec/serving");
    const timeline = record(facts, "rec/boot-timeline");
    const live = record(facts, "rec/liveness");
    return {
      servingSince: serving !== null && thisRun(serving, m) ? serving.at : null,
      ...(timeline !== null && thisRun(timeline, m)
        ? {
            bootTimeline: {
              upSeconds: timeline.upSeconds,
              steps: timeline.steps.map((s) => ({ step: s.step, ms: s.ms })),
            },
          }
        : {}),
      ...(live !== null && thisRun(live, m) ? { liveness: liveness(live) } : {}),
    };
  }
  const error: LastErrorRecord | null = record(facts, "rec/last-error");
  const words: LastWordsRecord | null = record(facts, "rec/last-words");
  const down = view.state === "parked" || view.state === "stopped-error";
  return {
    ...(view.state === "stopped-error" && error !== null
      ? { lastError: { message: error.message, at: error.at, source: error.source } }
      : {}),
    ...(down && words !== null
      ? { lastWords: { parkedBecause: words.parkedBecause, detail: words.detail, at: words.at } }
      : {}),
  };
}

/** The status body for `desired` (the stored one, or the one a wake or park just wrote) over the gathered facts. */
export function composeStatus(cfg: ControlConfig, facts: StatusFacts, desired: Desired = facts.desired): ControlStatus {
  const lastError = record(facts, "rec/last-error");
  const view = projectState({
    now: facts.now,
    desired,
    persistent: facts.persistent,
    groups: facts.groups,
    lastErrorAt: lastError === null ? null : Date.parse(lastError.at),
    interruption: facts.interruption,
    lastStartError: facts.lastStartError,
  });
  const m = view.instance;
  const blocks = boxBlocks(facts, view);
  const live = blocks.liveness === undefined ? null : record(facts, "rec/liveness");
  const busy = live === null ? 0 : live.payloads.filter((p) => p.holds.work + p.holds.wait > 0).length;
  return {
    v: 1,
    box: cfg.box.id,
    desired: desired.want,
    state: view.state,
    since: toInstant(view.since),
    frozen: facts.freeze.frozen,
    ...(m !== undefined && m.type !== undefined && m.zone !== undefined
      ? {
          instance: { id: m.id, type: m.type, az: m.zone, launchedAt: toInstant(m.launchedAt), lifecycle: m.lifecycle },
        }
      : {}),
    ...(view.machine === undefined ? {} : { machine: view.machine }),
    ...blocks,
    caps: {
      awakeHoursToday: hours(facts.caps?.awakeMinutes ?? 0),
      awakeHoursCap: cfg.caps.awakeHoursPerDay,
      onDemandHoursToday: hours(facts.caps?.onDemandMinutes ?? 0),
      onDemandHoursCap: cfg.caps.onDemandHoursPerDay ?? 0,
      monthSpendUsd: facts.caps?.monthSpendUsd ?? null,
      monthBudgetUsd: cfg.caps.monthlyBudgetUsd,
    },
    // The alert path verdict arrives with the alert sinks (C4); until then it is not known.
    alertPath: { level: "info" },
    summary: summary(facts, view.state, lastError, busy),
  };
}

function brandName(facts: StatusFacts): string {
  try {
    const cfg: unknown = JSON.parse(facts.records.get("config")?.value ?? "null");
    const brand =
      typeof cfg === "object" && cfg !== null
        ? (cfg as { readonly brand?: { readonly name?: unknown } }).brand
        : undefined;
    return typeof brand?.name === "string" && brand.name !== "" ? brand.name : "dozebox";
  } catch {
    return "dozebox";
  }
}

function summary(facts: StatusFacts, state: ControlStatus["state"], lastError: LastErrorRecord | null, busy: number) {
  const s = composeSummary({
    now: facts.now,
    state,
    brand: { name: brandName(facts) },
    cap: facts.freeze.frozen ? { rule: "frozen", blocksWake: true, frozenBy: facts.freeze.by } : null,
    lastError,
    busyPayloads: busy,
  });
  return { ...s, actions: [...s.actions] };
}
