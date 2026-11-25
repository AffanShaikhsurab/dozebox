// The CLI's AWS adapter: the `AwsOps` port on SDK v3 clients.
import type { AwsOps } from "../../ports/aws.ts";
import { makeAccountOps } from "./account.ts";
import { defaultClients, type AwsClients } from "./clients.ts";
import { makeEc2Ops } from "./ec2.ts";
import { makeSnsOps } from "./sns.ts";
import { makeSsmOps } from "./ssm.ts";

export type AwsOpsDeps = {
  readonly region: string;
  readonly tagPrefix: string;
  /** Where shared secrets live, such as `/dozebox/shared/`. */
  readonly sharedPath: string;
  readonly clients?: Partial<AwsClients>;
};

export function makeAwsOps(deps: AwsOpsDeps): AwsOps {
  const c = defaultClients(deps.region, deps.clients);
  return {
    ...makeEc2Ops(c.ec2, deps.tagPrefix),
    ...makeSsmOps(c.ssm, deps.sharedPath),
    ...makeSnsOps(c.sns),
    ...makeAccountOps({ region: deps.region, tagPrefix: deps.tagPrefix, ...c }),
  };
}
