// A control function over FakeAws for the shell tests: config, a counting wake token source, a Compute spy that
// records every call by name, captured log lines, and helpers that build Function URL events.
import type { Compute } from "@dozebox/control/ports/compute";
import { makeFakeAws, makeFakeSecretReader, type FakeAws } from "@dozebox/testkit/fakes";
import type { ControlConfig } from "../src/config.ts";
import type { AlertSink } from "../src/ports/alertSink.ts";
import type { SecretReader } from "../src/ports/sharedSecrets.ts";
import { assembleDeps, type Deps, type WakeIdempotency } from "../src/deps.ts";
import type { FunctionUrlEvent, FunctionUrlResult } from "../src/http/event.ts";
import { route } from "../src/http/router.ts";

export const TOKEN = "wake-token-0123456789abcdef";
export const ROOT = "/dozebox/main/";

export const CONFIG: ControlConfig = {
  v: 1,
  box: { id: "main", prefix: "dozebox", region: "us-east-1" },
  ssmPrefix: ROOT,
  stateTable: "dozebox-main-state",
  alertTopicArn: "arn:aws:sns:us-east-1:111122223333:dozebox-main-alerts",
  groups: { spot: null, fallback: null },
  metrics: { namespace: "Dozebox/main" },
  caps: { awakeHoursPerDay: 16, onDemandHoursPerDay: 3, monthlyBudgetUsd: 60, budgetName: "dozebox-main-monthly" },
  fallback: { enabled: false, unattended: false },
  wakeBudget: { perHour: 6, perDay: 24 },
  kill: { freezeParameter: `${ROOT}freeze` },
};

export type ComputeCall = { readonly op: keyof Compute; readonly args: ReadonlyArray<unknown> };

/** Wrap every Compute method so the test sees each call, reads and actions alike. */
export function spyCompute(inner: Compute, calls: ComputeCall[]): Compute {
  const seen = (op: keyof Compute, ...args: ReadonlyArray<unknown>): void => void calls.push({ op, args });
  return {
    describePersistent: async (boxId) => {
      calls.push({ op: "describePersistent", args: [boxId] });
      const m = await inner.describePersistent(boxId);
      // The real adapter adds the instance type and zone from DescribeInstances; FakeAws does not.
      return m === null ? null : { ...m, type: "t4g.medium", zone: "us-east-1a" };
    },
    startPersistent: (id, token) => {
      seen("startPersistent", id, token);
      return inner.startPersistent(id, token);
    },
    stopPersistent: (id, token) => {
      seen("stopPersistent", id, token);
      return inner.stopPersistent(id, token);
    },
    describeGroup: (name) => {
      seen("describeGroup", name);
      return inner.describeGroup(name);
    },
    setGroupDesired: (name, desired, token) => {
      seen("setGroupDesired", name, desired, token);
      return inner.setGroupDesired(name, desired, token);
    },
  };
}

export type World = {
  readonly aws: FakeAws;
  readonly deps: Deps;
  readonly computeCalls: ComputeCall[];
  readonly lines: string[];
  readonly tokenReads: () => number;
  readonly setToken: (t: string | null) => void;
  readonly call: (method: string, path: string, opts?: CallOptions) => Promise<Answer>;
};

export type CallOptions = {
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: string;
  readonly body?: string;
  /** Default: the right token in x-dozebox-token. Pass null to send none. */
  readonly token?: string | null;
};

export type Answer = FunctionUrlResult & { readonly json: unknown };

export function httpEvent(method: string, path: string, opts: CallOptions = {}): FunctionUrlEvent {
  const token = opts.token === undefined ? TOKEN : opts.token;
  return {
    rawPath: path,
    rawQueryString: opts.query ?? "",
    headers: { ...(token === null ? {} : { "x-dozebox-token": token }), ...opts.headers },
    ...(opts.body === undefined ? {} : { body: opts.body }),
    isBase64Encoded: false,
    requestContext: { requestId: "req-1", http: { method, path, sourceIp: "192.0.2.1" } },
  };
}

export function makeWorld(
  opts: {
    readonly config?: Partial<ControlConfig>;
    readonly idempotency?: WakeIdempotency;
    readonly sinks?: ReadonlyArray<AlertSink>;
    readonly secrets?: SecretReader;
  } = {},
): World {
  const aws = makeFakeAws();
  const computeCalls: ComputeCall[] = [];
  const lines: string[] = [];
  let token: string | null = TOKEN;
  let reads = 0;
  const config = { ...CONFIG, ...opts.config };
  const deps = assembleDeps({
    config,
    now: aws.clock.now,
    sink: (line) => lines.push(line),
    invocationId: "inv-1",
    ...(opts.idempotency === undefined ? {} : { idempotency: opts.idempotency }),
    ...(opts.sinks === undefined ? {} : { sinks: opts.sinks }),
    ports: {
      compute: spyCompute(aws.compute, computeCalls),
      records: aws.ssm.store(ROOT),
      state: aws.dynamodb.table,
      spend: aws.budgets.spend,
      notifier: aws.sns.notifier,
      volumes: aws.ebs.volumes,
      secrets: opts.secrets ?? makeFakeSecretReader(),
      wakeToken: {
        read: async () => {
          reads += 1;
          return token;
        },
      },
    },
  });
  return {
    aws,
    deps,
    computeCalls,
    lines,
    tokenReads: () => reads,
    setToken: (t) => {
      token = t;
    },
    call: async (method, path, o) => {
      const r = await route(deps, httpEvent(method, path, o));
      let json: unknown = null;
      try {
        json = JSON.parse(r.body);
      } catch {
        json = null;
      }
      return { ...r, json };
    },
  };
}

/** Narrow an answer body to a plain object for field checks. */
export type Body = Readonly<Record<string, unknown>> & {
  readonly decision?: unknown;
  readonly desired?: unknown;
  readonly state?: unknown;
  readonly error?: unknown;
  readonly frozen?: unknown;
  readonly summary?: unknown;
  readonly severity?: unknown;
};
export const body = (a: Answer): Body => a.json as Body;
