// Fakes for the CLI lane's ports: the control API, Terraform, the CLI's AWS calls, the prompt, the tools and the
// files. Each records its calls so tests can assert `--dry-run` made no mutating call.
import type { Clock } from "@dozebox/core/time";
import type {
  AdminEvent,
  AwsCli,
  AwsOps,
  CliDeps,
  CliFiles,
  CliVolumeView,
  ControlApi,
  DoctorFacts,
  EmailSubscription,
  Exec,
  Prompt,
  SnapshotView,
  Terraform,
  TerraformOutputs,
  Tools,
  WakeAnswer,
} from "dozebox";

type ControlStatus = Awaited<ReturnType<ControlApi["status"]>>;
type Call = { readonly op: string; readonly arg?: unknown };

export type FakeControlApi = ControlApi & {
  current: ControlStatus;
  nextWake: WakeAnswer | null;
  /** Runs on every admin event after it is recorded (a test moves tags, parks the fake box, ...). */
  onAdmin: ((event: AdminEvent) => unknown) | null;
  readonly calls: Array<Call>;
};

/** `status` answers `current`; `wake` answers `nextWake`, or accepted with `current`. */
export function makeFakeControlApi(initial: ControlStatus): FakeControlApi {
  const calls: FakeControlApi["calls"] = [];
  const f: FakeControlApi = {
    current: initial,
    nextWake: null,
    onAdmin: null,
    calls,
    status: async () => (calls.push({ op: "status" }), f.current),
    wake: async (opts) => {
      calls.push({ op: "wake", arg: opts });
      return f.nextWake ?? { kind: "accepted", status: f.current };
    },
    waitFor: async (what) => (calls.push({ op: "waitFor", arg: what }), f.current),
    alertsTest: async (severity) => void calls.push({ op: "alertsTest", arg: severity }),
    admin: async (event: AdminEvent) => {
      calls.push({ op: "admin", arg: event });
      return f.onAdmin === null ? { ok: true } : f.onAdmin(event);
    },
  };
  return f;
}

export function makeFakeTerraform(outputs: TerraformOutputs = {}): Terraform & {
  outputs: TerraformOutputs;
  changes: boolean;
  readonly calls: Array<{
    readonly op: string;
    readonly dir: string;
    readonly vars?: Readonly<Record<string, string>>;
  }>;
} {
  const calls: Array<{ readonly op: string; readonly dir: string; readonly vars?: Readonly<Record<string, string>> }> =
    [];
  const f = {
    outputs,
    changes: false,
    calls,
    init: async (dir: string) => void calls.push({ op: "init", dir }),
    plan: async (dir: string, vars: Readonly<Record<string, string>>) => (
      calls.push({ op: "plan", dir, vars }),
      f.changes
    ),
    apply: async (dir: string, vars: Readonly<Record<string, string>>) => {
      calls.push({ op: "apply", dir, vars });
      f.changes = false;
    },
    destroy: async (dir: string) => void calls.push({ op: "destroy", dir }),
    output: async (dir: string) => (calls.push({ op: "output", dir }), f.outputs),
  };
  return f;
}

export type FakeAwsOps = AwsOps & {
  snapshotList: SnapshotView[];
  volumeList: CliVolumeView[];
  readonly secretValues: Map<string, string>;
  readonly params: Map<string, { readonly value: string; readonly secure: boolean }>;
  readonly subscriptions: Map<string, EmailSubscription[]>;
  facts: DoctorFacts;
  spendUsd: number | null;
  caller: string;
  /** Names of ops that throw RunnerError `aws_denied` (for example `startAutomation`). */
  readonly denied: Set<string>;
  readonly calls: Array<Call>;
};

const denied = (op: string): Error =>
  Object.assign(new Error(`fake aws: ${op} denied`), { name: "RunnerError", code: "aws_denied", retryable: false });

export function makeFakeAwsOps(): FakeAwsOps {
  const calls: FakeAwsOps["calls"] = [];
  let n = 0;
  const record = (op: string, arg?: unknown): void => {
    calls.push(arg === undefined ? { op } : { op, arg });
    if (f.denied.has(op)) throw denied(op);
  };
  const f: FakeAwsOps = {
    snapshotList: [],
    volumeList: [],
    secretValues: new Map(),
    params: new Map(),
    subscriptions: new Map(),
    facts: {
      account: "111122223333",
      region: "us-east-1",
      costTagActive: true,
      unreservedConcurrency: 1000,
      spotVcpuQuota: 32,
      onDemandVcpuQuota: 32,
    },
    spendUsd: 0,
    caller: "arn:aws:iam::111122223333:user/operator",
    denied: new Set(),
    calls,
    snapshots: async () => f.snapshotList,
    createSnapshot: async (volumeId, label, token) => {
      record("createSnapshot", { volumeId, label, token });
      const id = `snap-${String(++n).padStart(17, "0")}`;
      f.snapshotList.unshift({ id, volumeId, state: "completed", startedAt: 0, label });
      return id;
    },
    deleteSnapshot: async (id) => {
      record("deleteSnapshot", id);
      f.snapshotList = f.snapshotList.filter((s) => s.id !== id);
    },
    volumes: async () => f.volumeList,
    createVolume: async (input) => {
      record("createVolume", input);
      const id = `vol-${String(++n).padStart(17, "0")}`;
      f.volumeList.push({ id, zone: input.zone, state: "available", active: false, retired: false });
      return id;
    },
    retireVolume: async (id) => {
      record("retireVolume", id);
      f.volumeList = f.volumeList.map((v) => (v.id === id ? { ...v, active: false, retired: true } : v));
    },
    putSecret: async (name, value) => void (record("putSecret", name), f.secretValues.set(name, value)),
    listSecrets: async () => [...f.secretValues.keys()],
    deleteSecret: async (name) => void (record("deleteSecret", name), f.secretValues.delete(name)),
    getParameter: async (name) => f.params.get(name)?.value ?? null,
    putParameter: async (name, value, opts) =>
      void (record("putParameter", { name, secure: opts.secure }), f.params.set(name, { value, secure: opts.secure })),
    listParameters: async (path) =>
      [...f.params.keys()].filter((k) => k.startsWith(path) && !k.slice(path.length).includes("/")),
    deleteParameter: async (name) => void (record("deleteParameter", name), f.params.delete(name)),
    doctorFacts: async () => f.facts,
    activateCostTag: async (key) => {
      record("activateCostTag", key);
      f.facts = { ...f.facts, costTagActive: true };
    },
    callerArn: async () => f.caller,
    startAutomation: async (document, params) => {
      record("startAutomation", { document, params });
      return `exec-${++n}`;
    },
    emailSubscriptions: async (topic) => f.subscriptions.get(topic) ?? [],
    subscribeEmail: async (topic, email) => {
      record("subscribeEmail", { topic, email });
      f.subscriptions.set(topic, [...(f.subscriptions.get(topic) ?? []), { endpoint: email, pending: true }]);
    },
    testSpendUsd: async () => f.spendUsd,
  };
  return f;
}

export type FakeAwsCli = AwsCli & {
  /** Answers each call; the default answers null. Throw to fail a call. */
  answer: (args: ReadonlyArray<string>) => unknown;
  readonly calls: Array<ReadonlyArray<string>>;
};

/** Records every `aws` argv; `answer` decides the parsed JSON (tests script it by service and operation). */
export function makeFakeAwsCli(answer: (args: ReadonlyArray<string>) => unknown = () => null): FakeAwsCli {
  const f: FakeAwsCli = {
    answer,
    calls: [],
    json: async (args) => (f.calls.push(args), f.answer(args)),
  };
  return f;
}

/** Answers every confirm with `yes` and every secret with the next queued value. */
export function makeFakePrompt(
  yes = true,
  secrets: ReadonlyArray<string> = [],
): Prompt & {
  readonly asked: ReadonlyArray<string>;
} {
  const asked: string[] = [];
  const queue = [...secrets];
  return {
    asked,
    confirm: async (q) => (asked.push(q), yes),
    secret: async (label) => {
      asked.push(label);
      const v = queue.shift();
      if (v === undefined) throw new Error(`fake prompt: no secret queued for ${label}`);
      return v;
    },
  };
}

export function makeFakeTools(
  versions: Partial<Record<"aws" | "terraform" | "node", string | null>> = {},
): Tools & { versions: Record<"aws" | "terraform" | "node", string | null> } {
  const f = {
    versions: { aws: "2.31.0", terraform: "1.14.1", node: "24.12.0", ...versions },
    version: async (t: "aws" | "terraform" | "node") => f.versions[t],
  };
  return f;
}

export function makeFakeCliFiles(initial: Readonly<Record<string, string>> = {}): CliFiles & {
  readonly files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readText: async (p) => files.get(p) ?? null,
    writeText: async (p, t) => void files.set(p, t),
  };
}

/** Records each run; prints `lines` through `onOutput`, then exits with `exitCode`. */
export function makeFakeCliExec(): Exec & {
  lines: string[];
  exitCode: number;
  readonly runs: Array<ReadonlyArray<string>>;
} {
  const f = {
    lines: [] as string[],
    exitCode: 0,
    runs: [] as Array<ReadonlyArray<string>>,
    run: async (argv: ReadonlyArray<string>, opts: { readonly onOutput: (line: string) => void }) => {
      f.runs.push(argv);
      for (const l of f.lines) opts.onOutput(l);
      return { exitCode: f.exitCode, signal: null };
    },
  };
  return f;
}

/**
 * A clock whose `sleep` moves time forward at once, so polling commands run to the end in a test. A `timeout`
 * signal fires when a sleep moves time past it.
 */
export function makeAutoClock(start = Date.parse("2026-11-25T00:00:00.000Z")): Clock & { readonly slept: number[] } {
  let now = start;
  const slept: number[] = [];
  const timers: Array<{ readonly at: number; readonly c: AbortController }> = [];
  const fire = (): void => {
    for (const t of timers)
      if (t.at <= now && !t.c.signal.aborted) t.c.abort(new DOMException("The operation timed out.", "TimeoutError"));
  };
  return {
    slept,
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      slept.push(ms);
      now += ms;
      fire();
      if (signal?.aborted) throw signal.reason;
    },
    timeout: (ms) => {
      const c = new AbortController();
      timers.push({ at: now + ms, c });
      return c.signal;
    },
  };
}

export type FakeCliDeps = CliDeps & {
  readonly control: FakeControlApi;
  readonly terraform: ReturnType<typeof makeFakeTerraform>;
  readonly aws: FakeAwsOps;
  readonly awsCli: FakeAwsCli;
  readonly fs: ReturnType<typeof makeFakeCliFiles>;
  readonly prompt: ReturnType<typeof makeFakePrompt>;
  readonly tools: ReturnType<typeof makeFakeTools>;
  readonly exec: ReturnType<typeof makeFakeCliExec>;
};

/** Every CLI port faked; `status` is the control API's first answer, `outputs` the stack's Terraform outputs. */
export function makeFakeCliDeps(opts: {
  readonly status: ControlStatus;
  readonly outputs?: TerraformOutputs;
  readonly prompt?: ReturnType<typeof makeFakePrompt>;
  readonly clock?: Clock;
}): FakeCliDeps {
  let id = 0;
  return {
    control: makeFakeControlApi(opts.status),
    terraform: makeFakeTerraform(opts.outputs ?? {}),
    aws: makeFakeAwsOps(),
    awsCli: makeFakeAwsCli(),
    agentSocket: null,
    clock: opts.clock ?? makeAutoClock(),
    fs: makeFakeCliFiles(),
    prompt: opts.prompt ?? makeFakePrompt(),
    tools: makeFakeTools(),
    exec: makeFakeCliExec(),
    ids: { random: () => `id-${++id}` },
  };
}

/** A parked box's `/v1/status`, overridable per field. */
export function controlStatusFixture(over: Partial<ControlStatus> = {}): ControlStatus {
  return {
    v: 1,
    box: "main",
    desired: "asleep",
    state: "parked",
    since: "2026-11-25T00:00:00.000Z",
    frozen: false,
    caps: {
      awakeHoursToday: 1,
      awakeHoursCap: 16,
      onDemandHoursToday: 0,
      onDemandHoursCap: 3,
      monthSpendUsd: 4.2,
      monthBudgetUsd: 60,
    },
    alertPath: { level: "ok" },
    summary: { level: "ok", headline: "Asleep.", detail: "Parked since 00:00.", next: "Wakes on demand.", actions: [] },
    ...over,
  };
}

/** `terraform output -json` of a set-up stack for box `main`. */
export function stackOutputsFixture(over: Readonly<Record<string, unknown>> = {}): TerraformOutputs {
  const values: Record<string, unknown> = {
    box_id: "main",
    region: "us-east-1",
    control_url: "https://d111111abcdef8.cloudfront.net",
    control_function_name: "dozebox-main-control",
    ssm_prefix: "/dozebox/main/",
    wake_token_parameter: "/dozebox/main/wake-token",
    alert_topic_arn: "arn:aws:sns:us-east-1:111122223333:dozebox-main-alerts",
    state_table_name: "dozebox-main-state",
    data_volume_id: "vol-0000000000000000a",
    instance_role_arn: "arn:aws:iam::111122223333:role/dozebox-main-box",
    ...over,
  };
  const out: Record<string, { readonly value: unknown; readonly sensitive: boolean }> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) out[k] = { value: v, sensitive: false };
  return out;
}
