// Fake IMDSv2 on loopback. Every metadata read needs a token from PUT /latest/api/token, like the real service.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export const IMDS_TOKEN_HEADER = "x-aws-ec2-metadata-token";
export const IMDS_TTL_HEADER = "x-aws-ec2-metadata-token-ttl-seconds";

export type SpotAction = { readonly action: "stop" | "terminate" | "hibernate"; readonly time: string };

export type ImdsIdentity = {
  readonly instanceId: string;
  readonly region: string;
  readonly availabilityZone: string;
  readonly instanceType: string;
};

export type ImdsRequest = { readonly method: string; readonly path: string; readonly token: string | null };

export type FakeImds = {
  readonly base: string;
  readonly requests: ReadonlyArray<ImdsRequest>;
  readonly identity: ImdsIdentity;
  /** Set or clear the Spot interruption notice served at /latest/meta-data/spot/instance-action. */
  readonly setSpotAction: (action: SpotAction | null) => void;
  readonly setLifecycle: (lifecycle: "spot" | "on-demand") => void;
  /** Invalidate every issued token: the next read with an old token gets 401. */
  readonly expireTokens: () => void;
  /** The next metadata read answers with this status (one shot). */
  readonly failNext: (status: number) => void;
  readonly close: () => Promise<void>;
};

export type FakeImdsOptions = Partial<ImdsIdentity> & { readonly lifecycle?: "spot" | "on-demand" };

type Reply = { readonly status: number; readonly body: string };

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return typeof v === "string" ? v : null;
}

/** Start a fake IMDS on 127.0.0.1 with a random port. Close it when the test ends. */
export async function startFakeImds(opts: FakeImdsOptions = {}): Promise<FakeImds> {
  const identity: ImdsIdentity = {
    instanceId: opts.instanceId ?? "i-0123456789abcdef0",
    region: opts.region ?? "us-east-1",
    availabilityZone: opts.availabilityZone ?? "us-east-1a",
    instanceType: opts.instanceType ?? "t4g.small",
  };
  let lifecycle = opts.lifecycle ?? "spot";
  let spotAction: SpotAction | null = null;
  let issued = 0;
  let failNext: number | null = null;
  const tokens = new Set<string>();
  const requests: ImdsRequest[] = [];

  const answer = (req: IncomingMessage): Reply => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const token = header(req, IMDS_TOKEN_HEADER);
    requests.push({ method: req.method ?? "GET", path, token });
    if (path === "/latest/api/token") {
      if (req.method !== "PUT") return { status: 405, body: "" };
      const ttl = Number(header(req, IMDS_TTL_HEADER));
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 21600) return { status: 400, body: "" };
      const value = `fake-imds-token-${++issued}`;
      tokens.add(value);
      return { status: 200, body: value };
    }
    if (req.method !== "GET") return { status: 405, body: "" };
    if (token === null || !tokens.has(token)) return { status: 401, body: "" };
    if (failNext !== null) {
      const status = failNext;
      failNext = null;
      return { status, body: "" };
    }
    switch (path) {
      case "/latest/meta-data/instance-id":
        return { status: 200, body: identity.instanceId };
      case "/latest/meta-data/instance-type":
        return { status: 200, body: identity.instanceType };
      case "/latest/meta-data/placement/availability-zone":
        return { status: 200, body: identity.availabilityZone };
      case "/latest/meta-data/instance-life-cycle":
        return { status: 200, body: lifecycle };
      case "/latest/meta-data/spot/instance-action":
        return spotAction ? { status: 200, body: JSON.stringify(spotAction) } : { status: 404, body: "" };
      case "/latest/dynamic/instance-identity/document":
        return { status: 200, body: JSON.stringify(identity) };
      default:
        return { status: 404, body: "" };
    }
  };

  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const r = answer(req);
      res.writeHead(r.status, { "content-type": "text/plain" }).end(r.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    identity,
    setSpotAction: (a) => {
      spotAction = a;
    },
    setLifecycle: (l) => {
      lifecycle = l;
    },
    expireTokens: () => tokens.clear(),
    failNext: (status) => {
      failNext = status;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
