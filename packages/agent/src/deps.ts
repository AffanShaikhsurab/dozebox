// The composition root: every port the agent uses, wired to its real adapter. Nothing else constructs adapters, so
// tests build the same `Deps` from fakes (test/support.ts) and run the same shell.
import * as fsp from "node:fs/promises";
import type { Clock } from "@dozebox/core/time";
import { makeAwsPorts, type AwsPorts } from "./adapters/aws/compose.ts";
import { makeSystemClock } from "./adapters/clock.ts";
import { makeNodeExec } from "./adapters/exec.ts";
import { makeNodeFiles } from "./adapters/files.ts";
import { makeHttpImds } from "./adapters/imds.ts";
import { makeJsonLogger } from "./adapters/log.ts";
import { makeSystemdNotify } from "./adapters/systemd.ts";
import type { AgentEnv } from "./env.ts";
import { makeErrorLog, type ErrorLog } from "./errors.ts";
import { resolveIdentity, writerOf, type Identity } from "./identity.ts";
import type { Exec } from "./ports/exec.ts";
import type { Files } from "./ports/files.ts";
import type { Logger } from "./ports/log.ts";
import type { SelfStopTarget } from "./ports/selfstop.ts";
import type { Systemd } from "./ports/systemd.ts";
import { makeRecordPublisher, type RecordPublisher } from "./records/publish.ts";

export type Deps = AwsPorts & {
  readonly env: AgentEnv;
  readonly clock: Clock;
  readonly log: Logger;
  readonly files: Files;
  readonly exec: Exec;
  readonly systemd: Systemd;
  readonly identity: Identity;
  readonly records: RecordPublisher;
  readonly errors: ErrorLog;
  /** How this machine parks itself: its group (IMDS tag `aws:autoscaling:groupName`) or a stop of itself. */
  readonly machine: SelfStopTarget;
  readonly exists: (path: string) => Promise<boolean>;
  readonly fetch: typeof fetch;
};

const GROUP_TAG = "aws:autoscaling:groupName";

/** Build the real dependencies. Reads IMDS and the boot id, so it is async and fails when either is missing. */
export async function makeDeps(env: AgentEnv): Promise<Deps> {
  const clock = makeSystemClock();
  const files = makeNodeFiles(fsp);
  const exec = makeNodeExec();
  const imds = makeHttpImds({ base: env.imdsUrl, timeout: clock.timeout });
  const identity = await resolveIdentity(env, { imds, files, signal: clock.timeout(10_000) });
  const log = makeJsonLogger((line) => process.stdout.write(line), clock.now, {
    box: identity.boxId,
    instanceId: identity.instanceId,
    bootId: identity.bootId,
  });
  const group = await imds.tag(GROUP_TAG, clock.timeout(5_000)).catch((e: unknown) => {
    log.log("warn", "no instance tags in IMDS: parking as a persistent machine", { error: e });
    return null;
  });
  const aws = makeAwsPorts({
    region: identity.region,
    root: identity.root,
    prefix: identity.prefix,
  });
  return {
    ...aws,
    env,
    clock,
    log,
    files,
    exec,
    systemd: makeSystemdNotify({ exec, notifySocket: env.notifySocket, timeout: clock.timeout }),
    identity,
    records: makeRecordPublisher({ writer: aws.recordWriter, clock, tag: writerOf(identity) }),
    errors: makeErrorLog(clock.now),
    machine: group
      ? { mode: "group", instanceId: identity.instanceId, groupName: group }
      : { mode: "persistent", instanceId: identity.instanceId },
    exists: (path) =>
      fsp.access(path).then(
        () => true,
        () => false,
      ),
    fetch,
  };
}
