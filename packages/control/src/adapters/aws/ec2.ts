// AWS adapter for the persistent machine (EC2), and the Compute port assembled from it and the group adapter.
//
// Client tokens (checked against the EC2 and Auto Scaling API references, 2026-11-25): StartInstances takes only
// InstanceId.N, AdditionalInfo and DryRun; StopInstances takes InstanceId.N, Hibernate, Force, SkipOsShutdown and
// DryRun; SetDesiredCapacity takes AutoScalingGroupName, DesiredCapacity and HonorCooldown. None accepts a client
// token, so the port's `token` is not sent: idempotency comes from the reconciler re-reading before it acts, and both
// calls are safe to repeat (start of a running machine and stop of a stopped one succeed). RunInstances and
// CreateVolume do take a ClientToken; CreateVolume's is used in ebs.ts (the module, not this adapter, runs instances).
//
// Eventual consistency: describes filter by tag (a filter never fails on an id EC2 does not know yet), a Spot request
// that is not visible yet reads as `none`, and the reconciler re-reads before every destructive step (part 9 R1).
import {
  DescribeInstancesCommand,
  DescribeSpotInstanceRequestsCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  EC2Client,
  type EC2ClientConfig,
  type Instance,
  type SpotInstanceRequest,
} from "@aws-sdk/client-ec2";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import type { Compute, MachineState, MachineView } from "../../ports/compute.ts";

const STATES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "stopping",
  "stopped",
  "shutting-down",
  "terminated",
]);
const LIVE: ReadonlySet<string> = new Set(["pending", "running", "stopping", "stopped"]);
const STOPPED_LIKE: ReadonlySet<string> = new Set(["stopping", "stopped", "shutting-down", "terminated"]);

/**
 * The time in StateTransitionReason, such as "User initiated (2026-11-24 21:00:05 GMT)", as epoch ms. AWS gives it
 * to the second, in GMT; emulators may write UTC. Null when the text has no time.
 */
export function parseTransitionTime(reason: string | undefined): number | null {
  const m = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (?:GMT|UTC)\)/.exec(reason ?? "");
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** A Spot request as the reconciler needs it. `marked-for-stop` is a status code, not a state. */
export function spotRequestOf(r: SpotInstanceRequest | null): MachineView["spotRequest"] {
  if (!r) return "none";
  if (r.Status?.Code?.startsWith("marked-for-stop")) return "marked-for-stop";
  if (r.State === "disabled") return "disabled";
  if (r.State === "active" || r.State === "open") return "active";
  return "none";
}

/** One DescribeInstances instance (and its Spot request, when it has one) as a MachineView. */
export function toMachineView(i: Instance, spot: SpotInstanceRequest | null): MachineView {
  const name = i.State?.Name ?? "";
  if (!i.InstanceId || !STATES.has(name)) {
    throw new RunnerError("internal", false, `DescribeInstances returned an instance without an id or a known state`);
  }
  const state = name as MachineState;
  const isSpot = i.InstanceLifecycle === "spot";
  return {
    id: i.InstanceId,
    state,
    lifecycle: isSpot ? "spot" : "on-demand",
    launchedAt: i.LaunchTime?.getTime() ?? 0,
    stoppingAt: STOPPED_LIKE.has(state) ? parseTransitionTime(i.StateTransitionReason) : null,
    spotRequest: isSpot ? spotRequestOf(spot) : "none",
  };
}

async function spotRequest(ec2: EC2Client, id: string | undefined): Promise<SpotInstanceRequest | null> {
  if (!id) return null;
  try {
    const out = await ec2.send(new DescribeSpotInstanceRequestsCommand({ SpotInstanceRequestIds: [id] }));
    return out.SpotInstanceRequests?.[0] ?? null;
  } catch (e) {
    const err = fromAws(e);
    // A request created a moment ago may not be visible yet (eventual consistency): report none, re-read next tick.
    if (err.code === "aws_not_found") return null;
    throw err;
  }
}

/** One EC2 client for the adapters that share it (machines, group instances, volumes). */
export const ec2Client = (cfg: EC2ClientConfig): EC2Client => new EC2Client(cfg);

export type AwsMachinesDeps = { readonly ec2: EC2Client; readonly prefix?: string };

export function makeAwsMachines(
  deps: AwsMachinesDeps,
): Pick<Compute, "describePersistent" | "startPersistent" | "stopPersistent"> {
  const { ec2 } = deps;
  const prefix = deps.prefix ?? "dozebox";
  return {
    describePersistent: async (boxId) => {
      try {
        const found: Instance[] = [];
        let next: string | undefined;
        do {
          const out = await ec2.send(
            new DescribeInstancesCommand({
              Filters: [
                { Name: `tag:${prefix}:box`, Values: [boxId] },
                { Name: `tag:${prefix}:role`, Values: ["persistent"] },
              ],
              NextToken: next,
            }),
          );
          for (const r of out.Reservations ?? []) found.push(...(r.Instances ?? []));
          next = out.NextToken;
        } while (next);
        const newest = found.toSorted((a, b) => (b.LaunchTime?.getTime() ?? 0) - (a.LaunchTime?.getTime() ?? 0));
        const pick = newest.find((i) => LIVE.has(i.State?.Name ?? "")) ?? newest[0];
        if (!pick) return null;
        return toMachineView(pick, await spotRequest(ec2, pick.SpotInstanceRequestId));
      } catch (e) {
        throw fromAws(e);
      }
    },
    startPersistent: async (id, _token) => {
      try {
        await ec2.send(new StartInstancesCommand({ InstanceIds: [id] }));
      } catch (e) {
        throw fromAws(e);
      }
    },
    stopPersistent: async (id, _token) => {
      try {
        await ec2.send(new StopInstancesCommand({ InstanceIds: [id] }));
      } catch (e) {
        throw fromAws(e);
      }
    },
  };
}

/** The Compute port: the persistent machine from EC2, the fallback group from Auto Scaling. */
export function makeAwsCompute(
  machines: Pick<Compute, "describePersistent" | "startPersistent" | "stopPersistent">,
  group: Pick<Compute, "describeGroup" | "setGroupDesired">,
): Compute {
  return { ...machines, ...group };
}
