// `dozebox bootstrap` (L2): the one-time account setup the stack needs: the Terraform state bucket and the deploy
// principal policies (`terraform/bootstrap`, applied from `<stack>/bootstrap`), then the `<prefix>:box` cost allocation
// tag. `--test-account <id>` refuses to run in any other account and tags what it creates `dozebox:test`.
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { stackDirOf } from "../context.ts";
import { positionals, say, stringOpt } from "../output.ts";

/** Where the generated bootstrap root takes the module from; `--source` overrides it (a fork, a local checkout). */
const BOOTSTRAP_SOURCE = "git::https://github.com/dozebox/dozebox.git//terraform/bootstrap?ref=v1.0.0";
const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function bootstrapRoot(source: string): string {
  return [
    "# Written by dozebox bootstrap. Safe to edit; bootstrap never overwrites it.",
    'variable "region" { type = string }',
    'variable "state_bucket_name" {',
    "  type    = string",
    "  default = null",
    "}",
    'variable "tags" {',
    "  type    = map(string)",
    "  default = {}",
    "}",
    'provider "aws" { region = var.region }',
    'module "bootstrap" {',
    `  source            = ${JSON.stringify(source)}`,
    "  region            = var.region",
    "  state_bucket_name = var.state_bucket_name",
    "  tags              = var.tags",
    "}",
    'output "state_bucket_name" { value = module.bootstrap.state_bucket_name }',
    'output "backend_hcl" { value = module.bootstrap.backend_hcl }',
    "",
  ].join("\n");
}

export const bootstrap: Command = {
  name: "bootstrap",
  summary: "Create the state bucket and deploy principal policies; activate the cost tag.",
  options: {
    region: { type: "string" },
    "state-bucket": { type: "string" },
    "test-account": { type: "string" },
    source: { type: "string" },
  },
  mode: "operator",
  mutates: true,
  run: async (ctx, values, args) => {
    positionals(args, []);
    const { aws, terraform, fs } = ctx.deps;
    const facts = await aws.doctorFacts();
    const region = stringOpt(values, "region") ?? facts.region ?? undefined;
    if (region === undefined || !REGION.test(region))
      throw new DozeboxCliError("usage", "pass --region like us-east-1");
    const bucket = stringOpt(values, "state-bucket");
    if (bucket !== undefined && !BUCKET.test(bucket)) throw new DozeboxCliError("usage", `bad bucket name ${bucket}`);
    if (facts.account === null) throw new DozeboxCliError("aws", "No working AWS credentials; see dozebox doctor.");
    const test = stringOpt(values, "test-account");
    if (test !== undefined) {
      if (!ACCOUNT.test(test)) throw new DozeboxCliError("usage", "--test-account is a 12-digit account id");
      if (facts.account !== test) {
        throw new DozeboxCliError(
          "refused",
          `--test-account ${test} but the credentials are for account ${facts.account}`,
        );
      }
    }

    const dir = `${stackDirOf(values).replace(/[\\/]+$/, "")}/bootstrap`;
    const main = `${dir}/main.tf`;
    if ((await fs.readText(main)) === null)
      await fs.writeText(main, bootstrapRoot(stringOpt(values, "source") ?? BOOTSTRAP_SOURCE));
    const vars: Record<string, string> = { region };
    if (bucket !== undefined) vars["state_bucket_name"] = bucket;
    if (test !== undefined) vars["tags"] = JSON.stringify({ "dozebox:test": "bootstrap" });
    await terraform.init(dir, ctx.signal);
    const changed = await terraform.plan(dir, vars, ctx.signal);
    if (changed) await terraform.apply(dir, vars, ctx.signal);
    say(ctx, values, changed ? `Bootstrapped account ${facts.account} in ${region}.` : "Bootstrap already applied.");

    let costTag: "active" | "pending" = "active";
    if (facts.costTagActive !== true) {
      try {
        await aws.activateCostTag("dozebox:box");
      } catch (e) {
        costTag = "pending";
        const why = e instanceof Error ? e.message : String(e);
        say(
          ctx,
          values,
          `Cost tag dozebox:box not active yet (${why}); AWS knows a tag only after it is used. Run bootstrap again tomorrow.`,
        );
      }
    }
    return { exitCode: EXIT.ok, json: { account: facts.account, region, applied: changed, costTag } };
  },
};
