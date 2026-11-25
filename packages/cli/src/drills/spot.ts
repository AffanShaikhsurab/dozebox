// D2: `dozebox drill spot`. A reclaim notice while a hold is live: the box parks anyway ("reclaim"), the Spot request
// stays open, and the next wake serves on Spot again. The test account has no FIS, so the notice is simulated on the
// box (see imds-proxy.ts); a real FIS run (`aws:ec2:send-spot-instance-interruptions`) would additionally prove that
// EC2's own notice reaches the IMDS path and that the control function's EC2 state-change route records the
// interruption.
import { MINUTE, SECOND } from "@dozebox/core/time";
import { DozeboxCliError } from "../command.ts";
import { aws, arr, boxInstances, obj, record, runningInstance, shell, str, waitUntil } from "./box.ts";
import { installScript, removeScript } from "./imds-proxy.ts";
import { HOLD_MINUTES } from "./timing.ts";
import { expectLifecycle, parkAndWait, servingOf, teardownSignal, wakeServing } from "./parked.ts";
import type { Drill, DrillContext } from "./types.ts";

const HOLD = `/opt/dozebox/current/bin/dozebox hold drill --payload marker --reason drill --for ${HOLD_MINUTES}m`;
const OPEN_REQUEST_STATES = new Set(["open", "disabled", "active"]);
/** The park reason the agent records for a Spot notice (ParkReason in the records protocol). */
const RECLAIM = "reclaim";

const fact = (ctx: DrillContext, k: string): string => {
  const v = ctx.facts.get(k);
  if (typeof v !== "string") throw new DozeboxCliError("problem", `an earlier step did not record ${k}`);
  return v;
};

async function requestState(ctx: DrillContext, instanceId: string, signal: AbortSignal): Promise<string> {
  const out = await aws(
    ctx,
    ["ec2", "describe-spot-instance-requests", "--filters", `Name=instance-id,Values=${instanceId}`],
    signal,
  );
  const r = obj(arr(out["SpotInstanceRequests"])[0]);
  return str(r["State"]) ?? "none";
}

export const spotDrill: Drill = {
  name: "spot",
  // One short Spot run (t4g.small about $0.006 an hour for about 20 minutes) and a second one at the end.
  estimateUsd: async () => 0.03,
  steps: [
    {
      id: "wake",
      deadlineMs: 15 * MINUTE,
      run: async (ctx, signal) => {
        const s = expectLifecycle(servingOf(await wakeServing(ctx, signal)), "spot");
        ctx.facts.set("spot.instance", s.id);
        ctx.facts.set("spot.type", s.type);
      },
    },
    {
      id: "hold",
      deadlineMs: 2 * MINUTE,
      run: async (ctx, signal) => {
        await shell(ctx, fact(ctx, "spot.instance"), HOLD, signal);
      },
    },
    {
      id: "notice",
      deadlineMs: 3 * MINUTE,
      run: async (ctx, signal) => {
        ctx.facts.set("spot.noticeAt", String(ctx.deps.clock.now()));
        // dozeboxd restarts at the end of the script, so the box may stop before SSM sees the command finish.
        const r = await shell(ctx, fact(ctx, "spot.instance"), installScript(), signal, { check: false });
        if (!r.stdout.includes("PROXY_OK")) {
          throw new DozeboxCliError(
            "problem",
            `the IMDS proxy did not come up: ${r.status}: ${(r.stderr || r.stdout).slice(-300)}`,
          );
        }
      },
    },
    {
      id: "reclaim",
      deadlineMs: 6 * MINUTE,
      run: async (ctx, signal) => {
        const id = fact(ctx, "spot.instance");
        await waitUntil(ctx, signal, 10 * SECOND, async () =>
          (await boxInstances(ctx, signal)).some((i) => i.id === id && i.state === "stopped") ? true : null,
        );
        const words = await record(ctx, "last-words", signal);
        const because = str(words?.["parkedBecause"]);
        if (because !== RECLAIM) {
          throw new DozeboxCliError(
            "problem",
            `the box stopped but last-words say ${because ?? "nothing"}: ${str(words?.["detail"]) ?? ""}`.trim(),
          );
        }
        const at = Date.parse(str(words?.["at"]) ?? "");
        if (!(at >= Number(fact(ctx, "spot.noticeAt")) - MINUTE)) {
          throw new DozeboxCliError("problem", "last-words are older than the notice: they are not from this drill");
        }
        ctx.facts.set("spot.parkedBecause", because);
      },
    },
    {
      id: "request-open",
      deadlineMs: 2 * MINUTE,
      run: async (ctx, signal) => {
        const state = await requestState(ctx, fact(ctx, "spot.instance"), signal);
        ctx.facts.set("spot.requestState", state);
        if (!OPEN_REQUEST_STATES.has(state)) {
          throw new DozeboxCliError(
            "problem",
            `the Spot request is ${state}; a reclaim must leave it open or disabled`,
          );
        }
      },
    },
    {
      id: "wake-again",
      deadlineMs: 15 * MINUTE,
      run: async (ctx, signal) => {
        const s = expectLifecycle(servingOf(await wakeServing(ctx, signal)), "spot");
        if (s.id !== fact(ctx, "spot.instance")) {
          throw new DozeboxCliError(
            "problem",
            `the second wake served ${s.id}, not the persistent ${fact(ctx, "spot.instance")}`,
          );
        }
      },
    },
  ],
  teardown: async (ctx) => {
    const signal = teardownSignal(ctx);
    const running = await runningInstance(ctx, signal).catch(() => null);
    // /run is cleared when the instance stops; this is for the case that the drill failed before the box did.
    if (running !== null) {
      await shell(ctx, running.id, removeScript(), signal, { check: false }).catch((e: unknown) => {
        ctx.log(`spot teardown: cleanup on ${running.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    await parkAndWait(ctx, signal);
  },
};
