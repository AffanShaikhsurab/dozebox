// Secrets and plain parameters through SSM Parameter Store.
import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import { fromAws, RunnerError } from "@dozebox/core/errors";
import type { AwsOps } from "../../ports/aws.ts";

export type SsmOps = Pick<
  AwsOps,
  "putSecret" | "listSecrets" | "deleteSecret" | "getParameter" | "putParameter" | "listParameters" | "deleteParameter"
>;

const SECRET_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

const notFound = (e: unknown): boolean => fromAws(e).code === "aws_not_found";

const wrap = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (e) {
    throw fromAws(e);
  }
};

function checkName(name: string): string {
  if (!SECRET_NAME.test(name)) {
    throw new RunnerError("invalid_input", false, `"${name}" is not a valid secret name (letters, digits, _ . -)`);
  }
  return name;
}

/** Names of the parameters directly under `path` (a trailing `/` is dropped; SSM wants none). */
async function listUnder(ssm: SSMClient, path: string): Promise<string[]> {
  const names: string[] = [];
  let next: string | undefined;
  do {
    const out = await ssm.send(
      new GetParametersByPathCommand({
        Path: path.endsWith("/") ? path.slice(0, -1) : path,
        Recursive: false,
        ...(next === undefined ? {} : { NextToken: next }),
      }),
    );
    for (const p of out.Parameters ?? []) if (p.Name !== undefined) names.push(p.Name);
    next = out.NextToken;
  } while (next);
  return names;
}

export function makeSsmOps(ssm: SSMClient, sharedPath: string): SsmOps {
  const shared = sharedPath.endsWith("/") ? sharedPath : `${sharedPath}/`;
  return {
    putSecret: (name, value) =>
      wrap(async () => {
        await ssm.send(
          new PutParameterCommand({
            Name: shared + checkName(name),
            Value: value,
            Type: "SecureString",
            Overwrite: true,
          }),
        );
      }),

    listSecrets: () => wrap(async () => (await listUnder(ssm, shared)).map((n) => n.slice(shared.length)).toSorted()),

    deleteSecret: (name) =>
      wrap(async () => {
        try {
          await ssm.send(new DeleteParameterCommand({ Name: shared + checkName(name) }));
        } catch (e) {
          if (!notFound(e)) throw e;
        }
      }),

    getParameter: (name) =>
      wrap(async () => {
        try {
          const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
          return out.Parameter?.Value ?? null;
        } catch (e) {
          if (notFound(e)) return null;
          throw e;
        }
      }),

    putParameter: (name, value, opts) =>
      wrap(async () => {
        await ssm.send(
          new PutParameterCommand({
            Name: name,
            Value: value,
            Type: opts.secure ? "SecureString" : "String",
            Overwrite: true,
          }),
        );
      }),

    listParameters: (path) => wrap(() => listUnder(ssm, path)),

    deleteParameter: (name) =>
      wrap(async () => {
        try {
          await ssm.send(new DeleteParameterCommand({ Name: name }));
        } catch (e) {
          if (!notFound(e)) throw e;
        }
      }),
  };
}
