// The loops of A3 and A5, built together because they share state: one phase, one supervisor, one health loop whose
// strikes and serving time the idle loop and the park read. `main.ts` passes them to `runAgent({ extra })`.
//
// - payloads: (re)start every payload when the config's definitions change (immediately, then every 5 minutes).
// - health:   checks and strikes; the first healthy check writes `rec/serving` and publishes the boot timeline.
// - idle:     the idle verdict; parks with reason `idle`.
import { RunnerError } from "@dozebox/core/errors";
import { MINUTE, toInstant } from "@dozebox/core/time";
import { bootTimeOf, makeBootTimeline, type BootTimeline } from "./boot/timeline.ts";
import type { ConfigLoader } from "./config/load.ts";
import type { Deps } from "./deps.ts";
import { messageOf } from "./errors.ts";
import { makeActivitySampler } from "./idle/activity.ts";
import { idleLoop } from "./idle/loop.ts";
import { park } from "./idle/park.ts";
import type { Loop } from "./loops.ts";
import { makePhaseCell, type ParkReason, type PhaseCell } from "./phase.ts";
import { NO_HOLDS, type HoldSource } from "./ports/holds.ts";
import type { PayloadSupervisor } from "./ports/payloads.ts";
import type { MakeLoop } from "./run.ts";
import { makeSupervisor } from "./supervisor/supervisor.ts";
import { healthLoop, type HealthLoop } from "./watchdog/health.ts";

export const RUN_DIR = "/run/dozebox";
const PAYLOADS_LOOP = "payloads";
const PAYLOADS_EVERY_MS = 5 * MINUTE;

export type AgentLoopsOptions = {
  /** A2's protocol store when present; health-only until then. */
  readonly holds?: HoldSource;
  /** Tests pass a fake supervisor. */
  readonly supervisor?: (deps: Deps, config: ConfigLoader) => PayloadSupervisor;
};

type Shared = {
  readonly phase: PhaseCell;
  readonly supervisor: PayloadSupervisor;
  readonly timeline: Promise<BootTimeline>;
  readonly holds: HoldSource;
  health: HealthLoop | null;
  readonly park: (reason: ParkReason, detail: string) => Promise<unknown>;
};

function share(deps: Deps, config: ConfigLoader, opts: AgentLoopsOptions): Shared {
  const log = deps.log.child({ component: "agent" });
  const phase = makePhaseCell({ phase: "booting", since: deps.clock.now() }, (p) => {
    void deps.files.writeAtomic(`${RUN_DIR}/phase`, `${p.phase}\n`).catch((e: unknown) => {
      log.log("warn", "could not write the phase file", { error: e });
    });
  });
  const supervisor =
    opts.supervisor?.(deps, config) ??
    makeSupervisor({
      exec: deps.exec,
      files: deps.files,
      log: deps.log,
      fetch: deps.fetch,
      stateDir: deps.env.stateDir,
      payloads: () => config.current().payloads,
      secret: deps.secrets.get,
      execPrefix: [],
      boxId: deps.identity.boxId,
    });
  const holds = opts.holds ?? NO_HOLDS;
  const timeline = bootTimeOf(deps.files, deps.clock.now()).then((bootAt) =>
    makeBootTimeline({ clock: deps.clock, records: deps.records, files: deps.files, bootAt }),
  );
  const s: Shared = {
    phase,
    supervisor,
    timeline,
    holds,
    health: null,
    park: (reason, detail) =>
      park(
        {
          clock: deps.clock,
          records: deps.records,
          errors: deps.errors,
          holds,
          payloads: supervisor,
          selfStop: deps.selfStop,
          target: deps.machine,
          phase,
          log: deps.log,
          strikes: () => s.health?.strikes() ?? 0,
        },
        reason,
        detail,
      ),
  };
  return s;
}

/** The A3/A5 loops, sharing one state made at the first call (startLoops calls them in order with one deps). */
export function makeAgentLoops(opts: AgentLoopsOptions = {}): ReadonlyArray<MakeLoop> {
  let shared: Shared | null = null;
  const get = (deps: Deps, config: ConfigLoader): Shared => (shared ??= share(deps, config, opts));

  const payloads: MakeLoop = (deps, config) => {
    const s = get(deps, config);
    let applied: string | null = null;
    return {
      name: PAYLOADS_LOOP,
      everyMs: PAYLOADS_EVERY_MS,
      immediate: true,
      tick: async (signal) => {
        const key = JSON.stringify(config.current().payloads);
        if (key === applied || s.phase.get().phase === "sleeping") return;
        try {
          if (applied === null) {
            const timeline = await s.timeline;
            await timeline.step("payload-start", () => s.supervisor.startAll(signal));
          } else {
            await s.supervisor.startAll(signal);
          }
          applied = key;
        } catch (e) {
          await deps.records.lastError("payloads", messageOf(e)).catch(() => {});
          throw e instanceof RunnerError ? e : new RunnerError("internal", true, messageOf(e), { cause: e });
        }
      },
    } satisfies Loop;
  };

  const health: MakeLoop = (deps, config) => {
    const s = get(deps, config);
    const box = config.current().box;
    s.health = healthLoop({
      clock: deps.clock,
      log: deps.log,
      payloads: s.supervisor,
      everyMs: box.health.checkEverySeconds * 1000,
      config: () => config.current().box.health,
      phase: s.phase,
      park: s.park,
      onServing: async (payload) => {
        await deps.records.put("rec/serving", { payload });
        await deps.records.delete("rec/last-error");
        await deps.records.delete("rec/last-words");
        await deps.files.writeAtomic(`${RUN_DIR}/serving`, `${toInstant(deps.clock.now())}\n`).catch(() => {});
        const timeline = await s.timeline;
        await timeline.step("serving", async () => {});
        await timeline.publish();
      },
    });
    return s.health;
  };

  const idle: MakeLoop = (deps, config) => {
    const s = get(deps, config);
    const sampler = makeActivitySampler({
      files: deps.files,
      payloads: () => config.current().payloads,
      healthy: (name) => s.health?.healthy(name) ?? false,
    });
    const idleCfg = () => config.current().box.idle;
    return idleLoop({
      clock: deps.clock,
      holds: s.holds,
      idleMs: () => idleCfg().idleMinutes * MINUTE,
      viewingGraceMs: () => idleCfg().viewingGraceMinutes * MINUTE,
      servingSince: () => s.health?.servingSince() ?? null,
      lastActivityAt: () => sampler.sample(deps.clock.now()),
      phase: s.phase.get,
      onVerdict: (v) => {
        const p = s.phase.get();
        const now = deps.clock.now();
        if (v.kind === "idle" && p.phase === "serving")
          s.phase.set({ phase: "idle-pending", since: now, sleepAt: v.sleepAt });
        if (v.kind === "awake" && p.phase === "idle-pending") s.phase.set({ phase: "serving", since: now });
      },
      park: s.park,
    });
  };

  return [payloads, health, idle];
}
