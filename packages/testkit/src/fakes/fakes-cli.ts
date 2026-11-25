// Fakes for the CLI lane's ports: the control API, Terraform, the CLI's AWS calls and the prompt. Each records its
// calls so tests can assert `--dry-run` made no mutating call.
import type {
  AdminEvent,
  AwsOps,
  CliVolumeView,
  ControlApi,
  DoctorFacts,
  Prompt,
  SnapshotView,
  Terraform,
  TerraformOutputs,
  WakeAnswer,
} from "dozebox";

type ControlStatus = Awaited<ReturnType<ControlApi["status"]>>;

export type FakeControlApi = ControlApi & {
  current: ControlStatus;
  nextWake: WakeAnswer | null;
  readonly calls: Array<{ readonly op: string; readonly arg?: unknown }>;
};

/** `status` answers `current`; `wake` answers `nextWake`, or accepted with `current`. */
export function makeFakeControlApi(initial: ControlStatus): FakeControlApi {
  const calls: FakeControlApi["calls"] = [];
  const f: FakeControlApi = {
    current: initial,
    nextWake: null,
    calls,
    status: async () => (calls.push({ op: "status" }), f.current),
    wake: async (opts) => {
      calls.push({ op: "wake", arg: opts });
      return f.nextWake ?? { kind: "accepted", status: f.current };
    },
    waitFor: async (what) => (calls.push({ op: "waitFor", arg: what }), f.current),
    alertsTest: async (severity) => void calls.push({ op: "alertsTest", arg: severity }),
    admin: async (event: AdminEvent) => (calls.push({ op: "admin", arg: event }), { ok: true }),
  };
  return f;
}

export function makeFakeTerraform(outputs: TerraformOutputs = {}): Terraform & {
  outputs: TerraformOutputs;
  changes: boolean;
  readonly calls: Array<{ readonly op: string; readonly dir: string }>;
} {
  const calls: Array<{ readonly op: string; readonly dir: string }> = [];
  const f = {
    outputs,
    changes: false,
    calls,
    init: async (dir: string) => void calls.push({ op: "init", dir }),
    plan: async (dir: string) => (calls.push({ op: "plan", dir }), f.changes),
    apply: async (dir: string) => void calls.push({ op: "apply", dir }),
    destroy: async (dir: string) => void calls.push({ op: "destroy", dir }),
    output: async (dir: string) => (calls.push({ op: "output", dir }), f.outputs),
  };
  return f;
}

export type FakeAwsOps = AwsOps & {
  snapshotList: SnapshotView[];
  volumeList: CliVolumeView[];
  readonly secretValues: Map<string, string>;
  facts: DoctorFacts;
  spendUsd: number | null;
  readonly calls: Array<{ readonly op: string; readonly arg?: unknown }>;
};

export function makeFakeAwsOps(): FakeAwsOps {
  const calls: FakeAwsOps["calls"] = [];
  let n = 0;
  const f: FakeAwsOps = {
    snapshotList: [],
    volumeList: [],
    secretValues: new Map(),
    facts: {
      account: "111122223333",
      region: "us-east-1",
      costTagActive: true,
      unreservedConcurrency: 1000,
      spotVcpuQuota: 32,
      onDemandVcpuQuota: 32,
    },
    spendUsd: 0,
    calls,
    snapshots: async () => f.snapshotList,
    createSnapshot: async (volumeId, label, token) => {
      calls.push({ op: "createSnapshot", arg: { volumeId, label, token } });
      const id = `snap-${String(++n).padStart(17, "0")}`;
      f.snapshotList.push({ id, volumeId, state: "completed", startedAt: 0, label });
      return id;
    },
    deleteSnapshot: async (id) => {
      calls.push({ op: "deleteSnapshot", arg: id });
      f.snapshotList = f.snapshotList.filter((s) => s.id !== id);
    },
    volumes: async () => f.volumeList,
    retireVolume: async (id) => {
      calls.push({ op: "retireVolume", arg: id });
      f.volumeList = f.volumeList.map((v) => (v.id === id ? { ...v, active: false, retired: true } : v));
    },
    putSecret: async (name, value) =>
      void (calls.push({ op: "putSecret", arg: name }), f.secretValues.set(name, value)),
    listSecrets: async () => [...f.secretValues.keys()],
    deleteSecret: async (name) => void (calls.push({ op: "deleteSecret", arg: name }), f.secretValues.delete(name)),
    doctorFacts: async () => f.facts,
    testSpendUsd: async () => f.spendUsd,
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
