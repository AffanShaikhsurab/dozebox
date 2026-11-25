// Raw EC2 events from EventBridge (terraform/control.tf: state changes and Spot interruption warnings for every
// instance in the region, without tags). Rule R1 (part 9 §9.1): an event only writes a record; the tick reads it and
// acts. A Spot warning for one of this box's machines becomes the `interruption` item (newest wins); events for other
// instances and state changes (the tick re-reads EC2 every minute) are dropped.
import type { Deps } from "../deps.ts";
import { KEYS, putNewest } from "../state/keys.ts";

const SPOT_WARNING = "EC2 Spot Instance Interruption Warning";

export function isEc2Event(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { readonly source?: unknown }).source === "aws.ec2";
}

export type Ec2EventOutcome = { readonly kept: boolean; readonly why: string };

const field = (o: unknown, key: string): unknown =>
  typeof o === "object" && o !== null ? (o as Readonly<Record<string, unknown>>)[key] : undefined;

/** True when `id` is the persistent machine or a machine of one of the box's groups. Describes only. */
async function ours(deps: Deps, id: string): Promise<boolean> {
  if ((await deps.compute.describePersistent(deps.config.box.id))?.id === id) return true;
  for (const name of [deps.config.groups.spot, deps.config.groups.fallback]) {
    if (name === null) continue;
    const g = await deps.compute.describeGroup(name).catch(() => null);
    if (g?.machines.some((m) => m.id === id)) return true;
  }
  return false;
}

export async function onEc2Event(deps: Deps, event: unknown): Promise<Ec2EventOutcome> {
  const type = field(event, "detail-type");
  const id = field(field(event, "detail"), "instance-id");
  if (type !== SPOT_WARNING) return { kept: false, why: "state-change" };
  if (typeof id !== "string" || id === "") return { kept: false, why: "no-instance" };
  if (!(await ours(deps, id))) return { kept: false, why: "other-instance" };
  const time = field(event, "time");
  const parsed = typeof time === "string" ? Date.parse(time) : Number.NaN;
  const at = Number.isFinite(parsed) ? parsed : deps.clock.now();
  const written = await putNewest(deps.state, KEYS.interruption, { instanceId: id, at }, at);
  return { kept: written === "written", why: written === "written" ? "interruption" : "older" };
}
