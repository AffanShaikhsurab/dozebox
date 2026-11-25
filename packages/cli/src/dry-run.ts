// `--dry-run` (part 5 §5.1): every call that would change state is printed instead of made; reads still happen so
// the printed plan is the real one. Terraform `init` and `plan` run (they change no cloud state; `plan` is the useful
// part of a dry run); `apply` and `destroy` are printed.
import type { CliDeps } from "./command.ts";
import type { AwsOps } from "./ports/aws.ts";
import type { ControlApi } from "./ports/control.ts";
import type { CliFiles, Terraform } from "./ports/terraform.ts";

const DRY_RUN_ID = "dry-run";

const vars = (v: Readonly<Record<string, string>>): string =>
  Object.entries(v)
    .map(([k, x]) => ` -var ${k}=${x}`)
    .join("");

export function dryRunDeps(deps: CliDeps, print: (line: string) => void): CliDeps {
  const c = deps.control;
  const control: ControlApi = {
    status: (signal) => c.status(signal),
    wake: async (opts) => {
      print(`POST /v1/wake?origin=${opts.origin} (Idempotency-Key ${opts.idempotencyKey})`);
      return { kind: "accepted", status: await c.status() };
    },
    waitFor: async (what) => {
      print(`wait until ${what}`);
      return c.status();
    },
    alertsTest: async (severity) => print(`POST /v1/alerts/test {"severity":"${severity}"}`),
    admin: async (event) => {
      if (event.action === "status") return c.admin(event);
      print(`lambda invoke admin ${JSON.stringify(event)}`);
      return { dryRun: true };
    },
  };

  const t = deps.terraform;
  const terraform: Terraform = {
    init: (dir, signal) => t.init(dir, signal),
    plan: (dir, v, signal) => t.plan(dir, v, signal),
    apply: async (dir, v) => print(`terraform -chdir=${dir} apply${vars(v)}`),
    destroy: async (dir) => print(`terraform -chdir=${dir} destroy`),
    output: (dir) => t.output(dir),
  };

  const a = deps.aws;
  const aws: AwsOps = {
    ...a,
    createSnapshot: async (volumeId, label) => (print(`ec2 create-snapshot ${volumeId} label=${label}`), DRY_RUN_ID),
    deleteSnapshot: async (id) => print(`ec2 delete-snapshot ${id}`),
    createVolume: async (i) => (print(`ec2 create-volume from ${i.snapshotId} in ${i.zone}`), DRY_RUN_ID),
    retireVolume: async (id) => print(`ec2 create-tags ${id} retired`),
    putSecret: async (name) => print(`ssm put-parameter shared/${name} (SecureString)`),
    deleteSecret: async (name) => print(`ssm delete-parameter shared/${name}`),
    putParameter: async (name, _v, o) => print(`ssm put-parameter ${name}${o.secure ? " (SecureString)" : ""}`),
    deleteParameter: async (name) => print(`ssm delete-parameter ${name}`),
    activateCostTag: async (key) => print(`ce update-cost-allocation-tags-status ${key} Active`),
    startAutomation: async (doc) => (print(`ssm start-automation-execution ${doc}`), DRY_RUN_ID),
    subscribeEmail: async (topic, email) => print(`sns subscribe ${topic} email ${email}`),
  };

  const fs: CliFiles = {
    readText: (p) => deps.fs.readText(p),
    writeText: async (p) => print(`write ${p}`),
  };

  return { ...deps, control, terraform, aws, fs };
}
