// Wire tests run the adapters against the local AWS emulator (Floci, `test/emulator/compose.yml`). This module picks
// the endpoint, refuses anything that is not loopback, and hands out fake keys, so a wire test cannot reach a real
// account. It imports no SDK: the tests build their clients from `target.config`.

export type WireConfig = {
  readonly endpoint: string;
  readonly region: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly maxAttempts: number;
};

export type WireTarget = {
  readonly config: WireConfig;
  /** Why the suites skip, or false when the emulator answered. */
  readonly skip: string | false;
};

const DEFAULT_ENDPOINT = "http://127.0.0.1:4566";
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/;

/** True when a missing emulator must fail the run instead of skipping it (CI, or `DOZEBOX_WIRE=required`). */
export const wireRequired = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env["DOZEBOX_WIRE"] === "required" || Boolean(env["CI"]);

/** The emulator endpoint from `DOZEBOX_WIRE_ENDPOINT`, default http://127.0.0.1:4566. Throws on a non-loopback URL. */
export function wireEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const endpoint = env["DOZEBOX_WIRE_ENDPOINT"] ?? DEFAULT_ENDPOINT;
  if (!LOOPBACK.test(endpoint)) {
    throw new Error(`DOZEBOX_WIRE_ENDPOINT=${endpoint}: wire tests only talk to an emulator on loopback`);
  }
  return endpoint.replace(/\/$/, "");
}

/**
 * Resolve the wire target once per test file. When the emulator does not answer, suites skip with the reason, or
 * the first case fails with it where a wire run is required.
 */
export async function resolveWire(env: NodeJS.ProcessEnv = process.env): Promise<WireTarget> {
  const endpoint = wireEndpoint(env);
  const config: WireConfig = {
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
  };
  const up = await fetch(`${endpoint}/_localstack/health`, { signal: AbortSignal.timeout(2_000) }).then(
    (r) => r.ok,
    () => false,
  );
  if (up) return { config, skip: false };
  const why = `the AWS emulator is not reachable at ${endpoint} (docker compose -f test/emulator/compose.yml up -d)`;
  if (wireRequired(env)) throw new Error(why);
  return { config, skip: why };
}

/** Poll `done` every `everyMs` of real time until it holds or `withinMs` passes. Wire tests only. */
export async function eventually(
  done: () => Promise<boolean>,
  what: string,
  withinMs = 30_000,
  everyMs = 250,
): Promise<void> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    if (await done()) return;
    if (Date.now() > deadline) throw new Error(`not within ${withinMs} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
