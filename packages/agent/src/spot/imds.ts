// IMDSv2 `spot/instance-action`: a session token (6 h) cached and renewed a minute before it ends or after a 401.
import { RunnerError } from "@dozebox/core/errors";
import { parseInstant, type Clock } from "@dozebox/core/time";
import type { SpotAction, SpotNotices } from "../ports/host.ts";

const TOKEN_TTL_SECONDS = 21_600;
const TOKEN_REFRESH_BEFORE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 2_000;
const ACTIONS: ReadonlyArray<SpotAction["action"]> = ["stop", "terminate", "hibernate"];

const fail = (what: string, status: number): RunnerError =>
  new RunnerError(status >= 500 ? "aws_unavailable" : "internal", true, `IMDS ${what}: HTTP ${status}`);

function parseNotice(text: string): SpotAction {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new RunnerError("internal", true, "IMDS spot/instance-action is not JSON", { cause: e });
  }
  const o = (typeof doc === "object" && doc !== null ? doc : {}) as Record<string, unknown>;
  const action = ACTIONS.find((a) => a === o["action"]);
  const at = parseInstant(o["time"]);
  if (action === undefined || at === null)
    throw new RunnerError("internal", true, "IMDS spot/instance-action is malformed");
  return { action, at };
}

export function makeImdsSpotNotices(deps: {
  readonly fetch: typeof fetch;
  readonly base: string;
  readonly clock: Clock;
}): SpotNotices {
  const base = deps.base.replace(/\/$/, "");
  let token: { readonly value: string; readonly expiresAt: number } | null = null;

  const newToken = async (signal: AbortSignal): Promise<string> => {
    const res = await deps.fetch(`${base}/latest/api/token`, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": String(TOKEN_TTL_SECONDS) },
      signal,
    });
    if (!res.ok) throw fail("token", res.status);
    const value = (await res.text()).trim();
    token = { value, expiresAt: deps.clock.now() + TOKEN_TTL_SECONDS * 1000 - TOKEN_REFRESH_BEFORE_MS };
    return value;
  };

  return {
    instanceAction: async (signal) => {
      const timeout = deps.clock.timeout(REQUEST_TIMEOUT_MS);
      const s = signal ? AbortSignal.any([signal, timeout]) : timeout;
      for (let attempt = 0; ; attempt++) {
        const value = token !== null && deps.clock.now() < token.expiresAt ? token.value : await newToken(s);
        const res = await deps.fetch(`${base}/latest/meta-data/spot/instance-action`, {
          headers: { "X-aws-ec2-metadata-token": value },
          signal: s,
        });
        if (res.status === 401 && attempt === 0) {
          token = null;
          continue;
        }
        if (res.status === 404) return null;
        if (res.status !== 200) throw fail("spot/instance-action", res.status);
        return parseNotice(await res.text());
      }
    },
  };
}
