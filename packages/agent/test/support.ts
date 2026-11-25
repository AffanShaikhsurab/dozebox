// Fakes for the shell tests: every port of `Deps` in memory, plus one ordered event list to assert on.
import { RunnerError } from "@dozebox/core/errors";
import { makeFakeClock, makeFakeExec, makeFakeFs, type FakeClock } from "@dozebox/testkit/fakes";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";
import { makeJsonLogger } from "../src/adapters/log.ts";
import type { Deps } from "../src/deps.ts";
import type { AgentEnv } from "../src/env.ts";
import { makeErrorLog } from "../src/errors.ts";
import type { Identity } from "../src/identity.ts";
import type { Files } from "../src/ports/files.ts";
import { makeRecordPublisher } from "../src/records/publish.ts";

export const IDENTITY: Identity = {
  boxId: "box-1",
  prefix: "dozebox",
  region: "us-east-1",
  instanceId: "i-0123456789abcdef0",
  availabilityZone: "us-east-1a",
  instanceType: "t4g.small",
  bootId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  root: "/dozebox/box-1/",
};

export const ENV: AgentEnv = {
  boxId: "box-1",
  prefix: "dozebox",
  region: null,
  stateDir: "/data/dozebox",
  imdsUrl: "http://127.0.0.1:1",
  notifySocket: "/run/systemd/notify",
  watchdogEveryMs: null,
};

export const boxConfig = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  box: { id: "box-1", prefix: "dozebox", region: "us-east-1" },
  brand: { name: "Dozebox", alertSubject: "Dozebox: box-1" },
  idle: { idleMinutes: 30, viewingGraceMinutes: 10, noProgressParkMinutes: 150 },
  health: { checkEverySeconds: 60, restartAtStrikes: [5, 10], parkAtStrikes: 15, restartsPerHour: 2 },
  failsafe: { bootDeadlineMinutes: 60, everyMinutes: 15 },
  caps: { awakeHoursPerDay: 16 },
  disk: { lowPct: 15, criticalPct: 5, hysteresisPct: 3 },
  alerts: { topicArn: "arn:aws:sns:us-east-1:111122223333:dozebox-box-1-alerts", dedupeSeconds: 3600 },
  logs: { group: "/dozebox/box-1/box", dailyBudgetMiB: 100 },
  presenceSources: { ssh: true, tcpPorts: [] },
  jail: { enabled: false, egress: "off", allowHosts: [] },
  tripwire: { enabled: false },
  payloads: ["web"],
  ...over,
});

export const payload = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  name: "web",
  user: "web",
  protocol: "none",
  start: { command: ["/usr/bin/python3", "-m", "http.server", "8080"] },
  health: { http: { url: "http://127.0.0.1:8080/" } },
  ...over,
});

export type Harness = {
  readonly deps: Deps;
  readonly clock: FakeClock;
  readonly events: string[];
  /** Parameters by relative name; a RunnerError value makes the read throw it. */
  readonly params: Map<string, string | RunnerError>;
  /** Records written, by name (last value). */
  readonly records: Map<string, string>;
  readonly files: Files;
  readonly fs: FsPromises;
  readonly lines: string[];
  readonly faults: Faults;
};

export type Faults = {
  /** Every record put fails with this error while set. */
  put: RunnerError | null;
  /** Every notify of this state fails. */
  notify: string | null;
};

export function harness(
  opts: { readonly env?: Partial<AgentEnv>; readonly files?: Record<string, string> } = {},
): Harness {
  const clock = makeFakeClock();
  const events: string[] = [];
  const params = new Map<string, string | RunnerError>([
    ["config", JSON.stringify(boxConfig())],
    ["payloads/web", JSON.stringify(payload())],
  ]);
  const records = new Map<string, string>();
  const fake = makeFakeFs(opts.files ?? {});
  const fs = fake.fs.promises as unknown as FsPromises;
  const files = makeNodeFiles(fs, 1);
  const lines: string[] = [];
  const log = makeJsonLogger((l) => lines.push(l), clock.now);
  const faults: Faults = { put: null, notify: null };
  const recordWriter = {
    put: async (name: string, value: string) => {
      if (faults.put) throw faults.put;
      events.push(`put:${name}`);
      records.set(name, value);
    },
    delete: async (name: string) => {
      events.push(`delete:${name}`);
      records.delete(name);
    },
  };
  const deps: Deps = {
    env: { ...ENV, ...opts.env },
    clock,
    log,
    files,
    exec: makeFakeExec([]),
    systemd: {
      notify: async (state) => {
        events.push(`notify:${state}`);
        if (faults.notify === state) throw new RunnerError("internal", true, `systemd-notify ${state} failed`);
      },
    },
    identity: IDENTITY,
    records: makeRecordPublisher({
      writer: recordWriter,
      clock,
      tag: { instanceId: IDENTITY.instanceId, bootId: IDENTITY.bootId },
    }),
    errors: makeErrorLog(clock.now),
    params: {
      get: async (name) => {
        events.push(`get:${name}`);
        const v = params.get(name);
        if (v instanceof RunnerError) throw v;
        return v ?? null;
      },
    },
    recordWriter,
    secrets: { get: unused("secrets") },
    machine: { mode: "persistent", instanceId: IDENTITY.instanceId },
    exists: async () => false,
    fetch: unused("fetch"),
    selfStop: { stopSelf: unused("selfStop") },
    volumes: { findActive: unused("volumes"), describe: unused("volumes"), attach: unused("volumes") },
    logs: { send: unused("logs") },
    notifierFor: () => ({ publish: unused("notifier") }),
  };
  return { deps, clock, events, params, records, files, fs, lines, faults };
}

function unused(what: string) {
  return () => Promise.reject(new Error(`${what} not used in this test`));
}

/** Let pending promise callbacks run (no real time passes). */
export const flush = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};
