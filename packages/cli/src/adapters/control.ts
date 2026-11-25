// The control API v1 over `fetch` (wake token in `x-dozebox-token`), plus admin events over `lambda invoke`.
import { createHash } from "node:crypto";
import type { Clock } from "@dozebox/core/time";
import { normalizeControlStatus, type ControlStatus } from "@dozebox/protocol/control";
import { DozeboxCliError } from "../command.ts";
import type { AdminEvent, ControlApi, WakeAnswer } from "../ports/control.ts";

export type SignableRequest = {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type ControlApiDeps = {
  readonly controlUrl: string;
  readonly functionName: string;
  readonly token: () => Promise<string>;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  /** SigV4 signer for a Function URL with `AWS_IAM` and no front door; null behind CloudFront. */
  readonly sign: ((req: SignableRequest) => Promise<SignableRequest>) | null;
  readonly invokeAdmin: (
    payload: object,
  ) => Promise<{ readonly functionError: string | null; readonly payload: unknown }>;
};

const POLL_MS = 10_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

type Reply = { readonly status: number; readonly headers: Headers; readonly body: unknown };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function errorFields(body: unknown): Readonly<Record<string, unknown>> {
  return isRecord(body) && isRecord(body["error"]) ? body["error"] : {};
}

function errorMessage(reply: Reply): string {
  const message = errorFields(reply.body)["message"];
  return typeof message === "string" && message !== "" ? message : `The control function answered ${reply.status}.`;
}

function retryAfterSeconds(reply: Reply): number {
  const err = errorFields(reply.body);
  const seconds = err["retryAfterSeconds"];
  if (typeof seconds === "number" && seconds > 0) return seconds;
  const ms = err["retryAfterMs"];
  if (typeof ms === "number" && ms > 0) return Math.ceil(ms / 1000);
  const header = Number(reply.headers.get("retry-after"));
  return Number.isFinite(header) && header > 0 ? header : DEFAULT_RETRY_AFTER_SECONDS;
}

function parseBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function decodeStatus(body: unknown): ControlStatus {
  try {
    return normalizeControlStatus(body);
  } catch (cause) {
    throw new DozeboxCliError("problem", "The control function sent a status this CLI cannot read.", { cause });
  }
}

const failed = (reply: Reply): DozeboxCliError => new DozeboxCliError("problem", errorMessage(reply));
const ok = (reply: Reply): boolean => reply.status >= 200 && reply.status < 300;

export function makeControlApi(deps: ControlApiDeps): ControlApi {
  let token: Promise<string> | null = null;
  const getToken = (): Promise<string> => (token ??= deps.token());

  async function attempt(
    method: "GET" | "POST",
    path: string,
    body: string,
    extra: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
  ): Promise<Reply> {
    const headers: Record<string, string> = { "x-dozebox-token": await getToken(), ...extra };
    if (method === "POST") headers["x-amz-content-sha256"] = body === "" ? EMPTY_BODY_SHA256 : sha256(body);
    const request: SignableRequest = { method, url: `${deps.controlUrl}${path}`, headers, body };
    const signed = deps.sign === null ? request : await deps.sign(request);
    const res = await deps.fetch(signed.url, {
      method,
      headers: { ...signed.headers },
      ...(method === "POST" && body !== "" ? { body } : {}),
      ...(signal === undefined ? {} : { signal }),
    });
    return { status: res.status, headers: res.headers, body: parseBody(await res.text()) };
  }

  /** Network errors and 5xx are retried at 1 s, 2 s and 4 s; everything else is the caller's to map. */
  async function call(
    method: "GET" | "POST",
    path: string,
    opts: {
      readonly body?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<Reply> {
    let problem = "";
    for (let n = 0; n <= RETRY_DELAYS_MS.length; n++) {
      try {
        const reply = await attempt(method, path, opts.body ?? "", opts.headers ?? {}, opts.signal);
        if (reply.status === 401 || reply.status === 403) {
          throw new DozeboxCliError(
            "refused",
            "The control function refused the wake token; run dozebox token rotate.",
          );
        }
        if (reply.status < 500) return reply;
        problem = errorMessage(reply);
      } catch (e) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        if (e instanceof DozeboxCliError) throw e;
        problem = e instanceof Error ? e.message : String(e);
      }
      const delay = RETRY_DELAYS_MS[n];
      if (delay === undefined) break;
      await deps.clock.sleep(delay, opts.signal);
    }
    throw new DozeboxCliError("aws", `The control function did not answer: ${problem}`);
  }

  async function status(signal?: AbortSignal): Promise<ControlStatus> {
    const reply = await call("GET", "/v1/status", signal === undefined ? {} : { signal });
    if (!ok(reply)) throw failed(reply);
    return decodeStatus(reply.body);
  }

  async function wake(opts: {
    readonly idempotencyKey: string;
    readonly origin: "user" | "auto";
  }): Promise<WakeAnswer> {
    const reply = await call("POST", `/v1/wake?origin=${encodeURIComponent(opts.origin)}`, {
      headers: { "Idempotency-Key": opts.idempotencyKey },
    });
    if (reply.status === 429) return { kind: "budget", retryAfterSeconds: retryAfterSeconds(reply) };
    if (reply.status === 423) return { kind: "frozen" };
    if (!ok(reply)) throw failed(reply);
    return { kind: "accepted", status: decodeStatus(reply.body) };
  }

  async function waitFor(what: "running" | "serving", signal: AbortSignal): Promise<ControlStatus> {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const current = await status(signal);
      if (current.state === "stopped-error") {
        throw new DozeboxCliError("problem", current.lastError?.message ?? current.summary.headline);
      }
      if (what === "running" ? current.state === "running" : typeof current.servingSince === "string") return current;
      await deps.clock.sleep(POLL_MS, signal);
    }
  }

  async function alertsTest(severity: "page" | "notify"): Promise<void> {
    const reply = await call("POST", "/v1/alerts/test", {
      body: JSON.stringify({ severity }),
      headers: { "content-type": "application/json" },
    });
    if (!ok(reply)) throw failed(reply);
  }

  async function admin(event: AdminEvent): Promise<unknown> {
    const result = await deps.invokeAdmin({ dozebox: "admin", v: 1, ...event });
    if (result.functionError !== null) {
      const detail =
        errorFields(result.payload)["message"] ?? (isRecord(result.payload) ? result.payload["errorMessage"] : null);
      throw new DozeboxCliError(
        "problem",
        `The control function failed on admin ${event.action} (${result.functionError})${typeof detail === "string" ? `: ${detail}` : "."}`,
      );
    }
    return result.payload;
  }

  return { status, wake, waitFor, alertsTest, admin };
}
