// The process shell (plan 11 A1): load the config (last good on invalid), start the loops, then READY=1, then wait
// for SIGTERM or SIGINT. READY=1 is sent only after every loop has started, so systemd's start (and the agent update's
// "READY=1 within 120 s" rollback rule) means a working agent, not a process that has merely launched.
import { MINUTE } from "@dozebox/core/time";
import { makeConfigLoader, type ConfigLoader } from "./config/load.ts";
import type { Deps } from "./deps.ts";
import { runLoops, type Loop, type RunningLoops } from "./loops.ts";
import { watchdogLoop } from "./watchdog/loop.ts";

export const CONFIG_EVERY_MS = 5 * MINUTE;

/** What the shell needs from `process`. */
export type Proc = {
  readonly once: (signal: "SIGTERM" | "SIGINT", fn: () => void) => unknown;
  readonly exit: (code: number) => void;
};

/** Loops added by later packages (idle, health, spot, disk); each gets the config loader for the current config. */
export type MakeLoop = (deps: Deps, config: ConfigLoader) => Loop;

/** Every loop the agent runs: the config reload, the extra loops, and the systemd watchdog ping when enabled. */
function startLoops(
  deps: Deps,
  config: ConfigLoader,
  opts: { readonly extra?: ReadonlyArray<MakeLoop>; readonly onFatal: (reason: string) => void },
): RunningLoops {
  const reload: Loop = {
    name: "config",
    everyMs: CONFIG_EVERY_MS,
    tick: async () => {
      await config.load();
    },
  };
  const loops = [reload, ...(opts.extra ?? []).map((make) => make(deps, config))];
  let running: RunningLoops | null = null;
  const every = deps.env.watchdogEveryMs;
  if (every !== null) {
    loops.push(
      watchdogLoop({ everyMs: every, clock: deps.clock, systemd: deps.systemd, beats: () => running?.beats() ?? [] }),
    );
  }
  running = runLoops({ clock: deps.clock, log: deps.log, errors: deps.errors, onFatal: opts.onFatal }, loops);
  return running;
}

export type RunningAgent = {
  readonly config: ConfigLoader;
  readonly loops: RunningLoops;
  /** Resolves with the exit code once the agent has stopped (signal: 0, fatal loop: 1). */
  readonly done: Promise<number>;
};

/**
 * Start the agent. Rejects (and sends nothing to systemd) when there is no usable config or READY=1 fails; the
 * caller logs it and exits non-zero, and systemd restarts the unit.
 */
export async function runAgent(
  deps: Deps,
  proc: Proc,
  opts: { readonly extra?: ReadonlyArray<MakeLoop> } = {},
): Promise<RunningAgent> {
  const log = deps.log.child({ component: "main" });
  const config = makeConfigLoader({
    params: deps.params,
    files: deps.files,
    records: deps.records,
    log: deps.log,
    identity: deps.identity,
    stateDir: deps.env.stateDir,
  });
  const first = await config.load();
  log.log("info", "config loaded", { from: first.from, payloads: first.payloads.map((p) => p.name) });

  const { promise: done, resolve: finish } = Promise.withResolvers<number>();
  let stopping = false;
  const shutdown = (code: number, why: string): void => {
    if (stopping) return;
    stopping = true;
    log.log(code === 0 ? "info" : "error", "stopping", { why });
    void deps.systemd
      .notify("STOPPING=1")
      .catch((e: unknown) => log.log("warn", "STOPPING=1 failed", { error: e }))
      .then(() => loops.stop())
      .then(() => {
        finish(code);
        proc.exit(code);
      });
  };

  const loops = startLoops(deps, config, { ...opts, onFatal: (reason) => shutdown(1, reason) });
  try {
    await deps.systemd.notify("READY=1");
  } catch (e) {
    await loops.stop();
    throw e;
  }
  log.log("info", "ready");
  for (const sig of ["SIGTERM", "SIGINT"] as const) proc.once(sig, () => shutdown(0, sig));
  return { config, loops, done };
}
