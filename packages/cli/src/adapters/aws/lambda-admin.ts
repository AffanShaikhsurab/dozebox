// Admin events: `lambda invoke` of the control function with the operator's IAM credentials.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { fromAws } from "@dozebox/core/errors";

export function makeLambdaAdmin(opts: {
  readonly region: string;
  readonly functionName: string;
  readonly client?: Pick<LambdaClient, "send">;
}): (payload: object) => Promise<{ readonly functionError: string | null; readonly payload: unknown }> {
  const client = opts.client ?? new LambdaClient({ region: opts.region });
  return async (payload) => {
    try {
      const out = await client.send(
        new InvokeCommand({
          FunctionName: opts.functionName,
          InvocationType: "RequestResponse",
          Payload: new TextEncoder().encode(JSON.stringify(payload)),
        }),
      );
      const text = out.Payload === undefined ? "" : new TextDecoder().decode(out.Payload);
      let body: unknown = null;
      if (text !== "") {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
      }
      return { functionError: out.FunctionError ?? null, payload: body };
    } catch (e) {
      throw fromAws(e);
    }
  };
}
