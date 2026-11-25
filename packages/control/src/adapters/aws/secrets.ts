// AWS adapter for the wake token: GetParameter with decryption on the SecureString `<root>wake-token`. The record
// store skips SecureStrings on purpose (ciphertext is never a record), so the token has its own port.
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { fromAws } from "@dozebox/core/errors";
import type { WakeTokenSource } from "../../ports/secrets.ts";

export type AwsWakeTokenDeps = {
  readonly ssm: SSMClient;
  /** The box root, such as `/dozebox/main/`. */
  readonly root: string;
};

export function makeAwsWakeToken(deps: AwsWakeTokenDeps): WakeTokenSource {
  const name = `${deps.root}wake-token`;
  return {
    read: async () => {
      try {
        const out = await deps.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
        const value = out.Parameter?.Value?.trim() ?? "";
        return value === "" ? null : value;
      } catch (e) {
        const err = fromAws(e);
        if (err.code === "aws_not_found") return null;
        throw err;
      }
    },
  };
}
