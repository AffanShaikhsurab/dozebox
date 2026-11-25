// P2: keepHold. Renewals run one at a time; a failed renewal is retried by the next tick.
import type { HoldInput } from "@dozebox/protocol/v1";
import { DozeboxError } from "./http.ts";
import type { DozeboxClient } from "./types.ts";

/** Runs `fn` every `ms` until the returned cancel is called. */
export type Every = (fn: () => void, ms: number) => () => void;

export const everyInterval: Every = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

export type KeepHoldDeps = {
  readonly hold: (id: string, input: HoldInput) => Promise<unknown>;
  readonly release: (id: string) => Promise<void>;
  readonly every: Every;
  readonly now: () => number;
};

export function makeKeepHold(deps: KeepHoldDeps): DozeboxClient["keepHold"] {
  return (id, opts) => {
    const renewMs = (opts.renewEverySeconds ?? Math.max(1, Math.floor(opts.forSeconds / 3))) * 1000;
    let stopped = false;
    let inflight: Promise<unknown> = Promise.resolve();

    const renew = (): void => {
      if (stopped) return;
      const input: HoldInput = {
        reason: opts.reason,
        until: new Date(deps.now() + opts.forSeconds * 1000).toISOString(),
        ...(opts.kind ? { kind: opts.kind } : {}),
      };
      inflight = inflight.then(() => deps.hold(id, input)).catch(() => undefined);
    };

    renew();
    const cancel = deps.every(renew, renewMs);
    let stopping: Promise<void> | undefined;

    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        stopped = true;
        cancel();
        await inflight;
        try {
          await deps.release(id);
        } catch (e) {
          if (!(e instanceof DozeboxError && e.code === "not_found")) throw e;
        }
      })();
      return stopping;
    };
    return { stop };
  };
}
