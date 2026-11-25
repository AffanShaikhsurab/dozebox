// The control API router (part 5 §5.3). Public assets first (the wake page holds no secret), then the token check
// for everything else, before any route lookup: a caller without the token learns nothing about which paths exist,
// what state the box is in, or whether a token is stored. Hooks (/v1/hooks/*) are the exception: their signature is
// their authentication (C5). Unversioned paths (`/status`, `/wake`, `/park`,
// `/alerts/test`) are aliases of the `/v1/` ones for clients of the old API (two minors, part 11 §11.5).
// Errors: an expected outcome is an answer from its route; anything thrown is logged by name and code only and
// answered 500 `internal` (SDK messages can embed ARNs).
import { RunnerError } from "@dozebox/core/errors";
import { REQUEST_BODY_LIMIT_BYTES } from "@dozebox/protocol/v1";
import type { Deps } from "../deps.ts";
import { toRequest, type FunctionUrlEvent, type FunctionUrlResult } from "./event.ts";
import { corsHeaders, errorResponse, respond } from "./respond.ts";
import { HOOKS_PREFIX, hooksRoute } from "./routes/hooks.ts";
import { publicAsset } from "./routes/pwa.ts";
import { alertsTestRoute, statusRoute } from "./routes/status.ts";
import { parkRoute, wakeRoute } from "./routes/wake.ts";
import { readOnly, type Route } from "./types.ts";

type Entry = { readonly method: "GET" | "POST"; readonly run: Route; readonly name: string };

const ROUTES: Readonly<Record<string, Entry>> = {
  "/v1/status": { method: "GET", run: statusRoute, name: "status" },
  "/v1/wake": { method: "POST", run: wakeRoute, name: "wake" },
  "/v1/park": { method: "POST", run: parkRoute, name: "park" },
  "/v1/alerts/test": { method: "POST", run: alertsTestRoute, name: "alerts-test" },
};

/** `/status` -> `/v1/status`; a `/v1/` path or an asset path is returned as it is. */
export function canonicalPath(path: string): string {
  return !path.startsWith("/v1/") && `/v1${path}` in ROUTES ? `/v1${path}` : path;
}

const withCors = (r: FunctionUrlResult, cors: Readonly<Record<string, string>>): FunctionUrlResult => ({
  ...r,
  headers: { ...cors, ...r.headers },
});

export async function route(deps: Deps, event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const started = deps.clock.now();
  const req = toRequest(event);
  const cors = corsHeaders(deps.tokenHeaders);
  let name = "unknown";
  let result: FunctionUrlResult;
  try {
    result = await dispatch(deps, req, (n) => {
      name = n;
    });
  } catch (e) {
    const code = e instanceof RunnerError ? e.code : null;
    if (code === null) deps.metrics.count("Bugs", { route: name });
    deps.log.log("error", "request failed", {
      route: name,
      error: e instanceof Error ? e.name : "unknown",
      code,
    });
    result = errorResponse("internal", "The control function failed; try again.");
  }
  deps.log.log("info", "request", {
    route: name,
    method: req.method,
    status: result.statusCode,
    ms: deps.clock.now() - started,
  });
  return withCors(result, cors);
}

async function dispatch(deps: Deps, req: ReturnType<typeof toRequest>, named: (n: string) => void) {
  if (req.method === "OPTIONS") {
    named("options");
    return respond(204, "");
  }
  const asset = publicAsset(req.method, req.path);
  if (asset !== null) {
    named("page");
    return asset;
  }
  if (Buffer.byteLength(req.body, "utf8") > REQUEST_BODY_LIMIT_BYTES) {
    named("too-large");
    return errorResponse("too_large", `the body is over ${REQUEST_BODY_LIMIT_BYTES} bytes`);
  }
  if (req.method === "POST" && req.path.startsWith(HOOKS_PREFIX)) {
    named("hook");
    return hooksRoute(readOnly(deps), req);
  }
  const auth = await deps.auth.check(req);
  if (auth !== "ok") {
    named("unauthorized");
    deps.log.log("info", "unauthorized", { outcome: auth });
    return errorResponse("unauthorized", "A valid x-dozebox-token header is required.");
  }
  const entry = ROUTES[canonicalPath(req.path)];
  if (entry === undefined) {
    named("not-found");
    return errorResponse("not_found", "No such route.");
  }
  named(entry.name);
  if (entry.method !== req.method) {
    return errorResponse("method_not_allowed", `Use ${entry.method}.`, {
      headers: { allow: `${entry.method}, OPTIONS` },
    });
  }
  return entry.run(readOnly(deps), req);
}
