// C3: read EC2, the group, the volumes, the records and the intent into one snapshot (one read of each). The status
// route reads the same facts (`gatherFacts`), so what the tick acts on and what the API shows cannot disagree.
import type { Observed } from "@dozebox/core/reconcile";
import { readRecord } from "@dozebox/core/records";
import type { MachineView } from "../ports/compute.ts";
import type { VolumeView } from "../ports/volumes.ts";
import { gatherFacts, type StatusFacts } from "../status/build.ts";
import type { Snapshot, TickDeps } from "./types.ts";

const LIVE_ATTACHMENT = new Set(["attaching", "attached", "busy", "detaching"]);

function persistentOf(m: MachineView | null): Observed["persistent"] {
  if (m === null) return null;
  // A request still marked-for-stop refuses a start, exactly like an active one.
  const spotRequest = m.spotRequest === "marked-for-stop" ? "active" : m.spotRequest;
  return { id: m.id, state: m.state, stoppingAt: m.stoppingAt, spotRequest, launchedAt: m.launchedAt };
}

function volumeOf(volumes: ReadonlyArray<VolumeView>): Observed["volume"] {
  const v = volumes.find((x) => x.active);
  if (v === undefined) return { id: "", attachedTo: null, active: false };
  const holder = v.attachments.find((a) => LIVE_ATTACHMENT.has(a.state));
  return { id: v.id, attachedTo: holder?.machineId ?? null, active: true };
}

function sleepFenceOf(facts: StatusFacts): Observed["sleepFence"] {
  const r = readRecord("fence/sleep-requested", facts.records.get("fence/sleep-requested")?.value ?? null, null);
  if (r.kind !== "ok") return null;
  const at = Date.parse(r.record.at);
  return Number.isFinite(at) ? { at, phase: r.record.phase } : null;
}

export async function observe(deps: TickDeps, now: number): Promise<Snapshot> {
  const [facts, volumes] = await Promise.all([gatherFacts(deps, now), deps.volumes.describeBox(deps.config.box.id)]);
  const groupName = deps.config.groups.fallback ?? deps.config.groups.spot;
  const role = deps.config.groups.fallback === null ? "spot" : "fallback";
  const g = groupName === null ? undefined : facts.groups.find((x) => x.role === role);
  const group: Observed["group"] =
    g === undefined
      ? null
      : {
          desired: g.desired,
          instances: g.machines.map((m) => ({ id: m.id, state: m.state, launchedAt: m.launchedAt })),
        };
  const launches = [facts.persistent?.launchedAt ?? null, ...(group?.instances.map((i) => i.launchedAt) ?? [])];
  const known = launches.filter((t): t is number => t !== null && t > 0);
  const observed: Observed = {
    now,
    persistent: persistentOf(facts.persistent),
    group,
    volume: volumeOf(volumes),
    sleepFence: sleepFenceOf(facts),
    interruption: facts.interruption,
    lastStartError: facts.lastStartError,
    frozen: facts.freeze.frozen,
    onDemandAllowed: deps.config.fallback.enabled,
    lastLaunchAt: known.length > 0 ? Math.max(...known) : null,
  };
  return { desired: facts.desired, observed, facts, groupName };
}
