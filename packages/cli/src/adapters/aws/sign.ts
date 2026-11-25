// SigV4 for a Function URL with `AWS_IAM` (service `lambda`). Credentials come from the default provider chain.
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { SignableRequest } from "../control.ts";

type Credentials = ConstructorParameters<typeof SignatureV4>[0]["credentials"];

/** `https://<id>.lambda-url.<region>.on.aws`: the region, or null for any other URL. */
export function functionUrlRegion(controlUrl: string): string | null {
  try {
    return /^[a-z0-9]+\.lambda-url\.([a-z0-9-]+)\.on\.aws$/.exec(new URL(controlUrl).hostname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function makeSigner(opts: {
  readonly region: string;
  readonly credentials?: Credentials;
}): (req: SignableRequest) => Promise<SignableRequest> {
  const signer = new SignatureV4({
    credentials: opts.credentials ?? defaultProvider(),
    region: opts.region,
    service: "lambda",
    sha256: Sha256,
  });
  return async (req) => {
    const url = new URL(req.url);
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const signed = await signer.sign({
      method: req.method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query,
      headers: { ...req.headers, host: url.host },
      body: req.body,
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(signed.headers)) if (k.toLowerCase() !== "host") headers[k] = v;
    return { ...req, headers };
  };
}
