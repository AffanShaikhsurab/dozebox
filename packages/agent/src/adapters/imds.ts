// IMDSv2 over HTTP: PUT a session token (6 h), then GET with it. A 401 means the token expired; one new token is
// fetched and the read repeated. Every request has a 2 s timeout unless the caller passes a signal.
import { RunnerError } from "@dozebox/core/errors";
import type { Imds, InstanceFacts } from "../ports/imds.ts";

const TOKEN_TTL_SECONDS = 21_600;

export type HttpImdsDeps = {
  /** Default `http://169.254.169.254`. */
  readonly base?: string;
  readonly fetch?: typeof fetch;
  readonly timeout?: (ms: number) => AbortSignal;
};

const fail = (what: string, status: number): RunnerError =>
  new RunnerError(status >= 500 ? "aws_unavailable" : "internal", status >= 500, `IMDS ${what}: HTTP ${status}`);

export function makeHttpImds(deps: HttpImdsDeps = {}): Imds {
  const base = (deps.base ?? "http://169.254.169.254").replace(/\/$/, "");
  const doFetch = deps.fetch ?? fetch;
  const timeout = deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  let token: string | null = null;

  const newToken = async (signal: AbortSignal): Promise<string> => {
    const res = await doFetch(`${base}/latest/api/token`, {
      method: "PUT",
      headers: { "x-aws-ec2-metadata-token-ttl-seconds": String(TOKEN_TTL_SECONDS) },
      signal,
    });
    if (!res.ok) throw fail("token", res.status);
    return (await res.text()).trim();
  };

  const get = async (path: string, signal?: AbortSignal): Promise<string> => {
    const s = signal ?? timeout(2_000);
    for (let attempt = 0; ; attempt++) {
      token ??= await newToken(s);
      const res = await doFetch(`${base}${path}`, { headers: { "x-aws-ec2-metadata-token": token }, signal: s });
      if (res.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      if (!res.ok) throw fail(path, res.status);
      return (await res.text()).trim();
    }
  };

  return {
    instance: async (signal) => {
      const doc: unknown = JSON.parse(await get("/latest/dynamic/instance-identity/document", signal));
      const field = (k: string): string => {
        const v = (doc as Record<string, unknown> | null)?.[k];
        if (typeof v !== "string" || v === "") throw new RunnerError("internal", false, `IMDS document has no ${k}`);
        return v;
      };
      const facts: InstanceFacts = {
        instanceId: field("instanceId"),
        region: field("region"),
        availabilityZone: field("availabilityZone"),
        instanceType: field("instanceType"),
      };
      return facts;
    },
  };
}
