// POST /v1/hooks/{github,generic/<topic>} (part 5 §5.6, C5). The signature is the authentication, so the router sends
// these here before the token check. A matching event writes desired = awake with origin `event` through the same
// judgement as /v1/wake (freeze, budget, breaker); like /v1/wake it never calls Compute, and the tick acts.
import { readRecord } from "@dozebox/core/records";
import { countWakes, decideWake } from "@dozebox/core/wake";
import type { BoxWakes } from "../../ports/wakeSource.ts";
import { gatherFacts } from "../../status/build.ts";
import { IDEMPOTENCY_TTL_SECONDS } from "../../state/idempotency.ts";
import { readBreaker } from "../../state/keys.ts";
import { handleHook } from "../../wake/hooks.ts";
import type { FunctionUrlResult, Request } from "../event.ts";
import { errorResponse, json } from "../respond.ts";
import type { HttpDeps } from "../types.ts";

export const HOOKS_PREFIX = "/v1/hooks/";

async function boxWakes(deps: HttpDeps): Promise<BoxWakes> {
  const r = readRecord("rec/wakes", (await deps.records.get("rec/wakes"))?.value ?? null, null);
  return r.kind === "ok" ? r.record.wakes : [];
}

async function requestWake(deps: HttpDeps, why: string): Promise<void> {
  const now = deps.clock.now();
  const [facts, acceptedAt, breaker] = await Promise.all([
    gatherFacts(deps, now),
    deps.wakeLedger.read(now),
    readBreaker(deps.state),
  ]);
  const decision = decideWake({
    now,
    origin: "event",
    desired: facts.desired,
    frozen: facts.freeze.frozen,
    budget: { ...countWakes(acceptedAt, now), ...deps.config.wakeBudget },
    ...(breaker === null ? {} : { breaker }),
  });
  if (decision.kind === "accept" && (await deps.desired.write(decision.desired)) === "written") {
    await deps.wakeLedger.append(now);
    deps.metrics.count("WakeAccepted", { origin: "event" });
  }
  deps.log.log("info", "hook wake", { why, decision: decision.kind });
}

export async function hooksRoute(deps: HttpDeps, req: Request): Promise<FunctionUrlResult> {
  const answer = await handleHook(
    {
      sources: deps.wakeSources,
      wakes: () => boxWakes(deps),
      firstDelivery: async (key) =>
        (await deps.state.putIfAbsent(`hook#${key}`, { at: deps.clock.now() }, IDEMPOTENCY_TTL_SECONDS)) === "written",
      requestWake: (why) => requestWake(deps, why),
      now: deps.clock.now,
    },
    { method: req.method, path: req.path, headers: req.headers, rawBody: req.rawBody },
  );
  switch (answer.status) {
    case 202:
      return json(202, { v: 1, ...answer.body });
    case 401:
      return errorResponse("unauthorized", "The signature does not match.");
    case 404:
      return errorResponse("not_found", "No such hook.");
    case 413:
      return errorResponse("too_large", "The body is too large.");
  }
}
