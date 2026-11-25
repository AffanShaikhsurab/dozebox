// AWS adapter for the box's record writes: SSM PutParameter and DeleteParameter under `/<prefix>/<boxId>/` (the box
// role may write only `rec/*` and `fence/*` there). Plain `String` parameters with `Overwrite`, in the tier the
// record registry gives; name and size are checked before any call (core's assertFits). Advanced is one-way
// (notes/06b §1.10): a Standard write SSM refuses as a downgrade is repeated once as Advanced. The same rules as the
// control function's record store (packages/control/src/adapters/aws/ssm.ts); the agent may not import it.
// The parameter reader is the agent's GetParameter on `config` and `payloads/<name>` (plain String parameters).
import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
  type SSMClientConfig,
} from "@aws-sdk/client-ssm";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import { assertFits, type Tier } from "@dozebox/core/records";
import type { ParameterReader } from "../../ports/params.ts";
import type { RecordWriter } from "../../ports/records.ts";
import type { SecretReader } from "../../ports/secrets.ts";

export const ssmClient = (cfg: SSMClientConfig): SSMClient => new SSMClient(cfg);

export type AwsRecordWriterDeps = {
  readonly ssm: SSMClient;
  /** The box root, such as `/dozebox/box-1/`: starts and ends with `/`. */
  readonly root: string;
};

const ROOT = /^\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/$/;

export function makeAwsRecordWriter(deps: AwsRecordWriterDeps): RecordWriter {
  const { ssm, root } = deps;
  if (!ROOT.test(root)) throw new Error(`"${root}" is not a parameter root like /dozebox/box-1/`);
  const put = (name: string, value: string, tier: Tier) =>
    ssm.send(
      new PutParameterCommand({ Name: `${root}${name}`, Value: value, Type: "String", Tier: tier, Overwrite: true }),
    );
  return {
    put: async (name, value, { tier }) => {
      assertFits(name, value, tier);
      try {
        await put(name, value, tier);
      } catch (e) {
        const err = fromAws(e);
        if (tier === "Advanced" || err.code !== "invalid_input" || !/downgrade/i.test(err.message)) throw err;
        try {
          await put(name, value, "Advanced");
        } catch (again) {
          throw fromAws(again);
        }
      }
    },
    delete: async (name) => {
      assertFits(name, "", "Standard");
      try {
        await ssm.send(new DeleteParameterCommand({ Name: `${root}${name}` }));
      } catch (e) {
        const err = fromAws(e);
        if (err.code !== "aws_not_found") throw err;
      }
    },
  };
}

export type AwsParameterReaderDeps = AwsRecordWriterDeps;

export function makeAwsParameterReader(deps: AwsParameterReaderDeps): ParameterReader {
  const { ssm, root } = deps;
  if (!ROOT.test(root)) throw new Error(`"${root}" is not a parameter root like /dozebox/box-1/`);
  return {
    get: async (name) => {
      assertFits(name, "", "Standard");
      try {
        const out = await ssm.send(new GetParameterCommand({ Name: `${root}${name}` }));
        return out.Parameter?.Value ?? null;
      } catch (e) {
        const err = fromAws(e);
        if (err.code === "aws_not_found") return null;
        throw err;
      }
    },
  };
}

/** SecureStrings under `/<prefix>/shared/` (the box role may read and decrypt only these). */
export function makeAwsSecretReader(deps: { readonly ssm: SSMClient; readonly prefix: string }): SecretReader {
  return {
    get: async (name) => {
      if (!/^[a-z0-9-]{1,40}$/.test(name))
        throw new RunnerError("invalid_input", false, `"${name}" is not a secret name`);
      try {
        const out = await deps.ssm.send(
          new GetParameterCommand({ Name: `/${deps.prefix}/shared/${name}`, WithDecryption: true }),
        );
        return out.Parameter?.Value ?? null;
      } catch (e) {
        const err = fromAws(e);
        if (err.code === "aws_not_found") return null;
        throw err;
      }
    },
  };
}
