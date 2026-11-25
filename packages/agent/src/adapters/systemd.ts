// sd_notify through `systemd-notify` as a child process: Node cannot send Unix datagrams (part 6 §6.3 "Dead man's
// switches"), so the unit needs `NotifyAccess=all`. Without NOTIFY_SOCKET (not under systemd) every call is a no-op.
// systemd-notify waits until the manager has read the message, so READY=1 cannot be lost to the helper exiting first.
import { RunnerError } from "@dozebox/core/errors";
import type { Exec } from "../ports/exec.ts";
import type { Systemd } from "../ports/systemd.ts";

export type SystemdNotifyDeps = {
  readonly exec: Exec;
  readonly notifySocket: string | undefined;
  readonly timeout: (ms: number) => AbortSignal;
};

const STATE = /^[A-Z_]+=[^\n]*$/;

export function makeSystemdNotify(deps: SystemdNotifyDeps): Systemd {
  return {
    notify: async (state) => {
      if (!STATE.test(state)) throw new Error(`"${state}" is not one sd_notify assignment`);
      if (!deps.notifySocket) return;
      const r = await deps.exec.run(["systemd-notify", state], { signal: deps.timeout(5_000) });
      if (r.code !== 0) {
        throw new RunnerError("internal", true, `systemd-notify ${state} exited ${r.code}: ${r.stderr.trim()}`);
      }
    },
  };
}
