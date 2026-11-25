// POST /v1/wake and POST /v1/park (part 5 §5.3; part 9 R1, R2). Both only write the desired state; the reconcile tick
// reads it and acts, so neither route calls a Compute action (SIM-F5). A wake is judged by core's `decideWake`
// (freeze, then already awake, then the wake budget, then the breaker for unattended wakes). A park is always
// written, even when nothing runs (R2, SIM-F8), so an older wake can never undo it.
import { countWakes, decidePark, decideWake, type WakeOrigin } from "@dozebox/core/wake";
import type { Desired } from "@dozebox/core/reconcile";
import type { ControlAnswer, ControlDecision } from "@dozebox/protocol/control";
import { composeStatus, gatherFacts, type StatusFacts } from "../../status/build.ts";
import { readBreaker } from "../../state/keys.ts";
import type { FunctionUrlResult, Request } from "../event.ts";
import { errorResponse, json } from "../respond.ts";
import type { HttpDeps } from "../types.ts";

/** `Idempotency-Key`: 1 to 64 visible ASCII characters (part 5 §5.3). */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,64}$/;

type Origin = { readonly wake: WakeOrigin; readonly park: Desired["origin"] };
const ORIGINS: Readonly<Record<string, Origin>> = {
  user: { wake: "person", park: "user" },
  auto: { wake: "event", park: "auto" },
};

function originOf(req: Request): Origin | null {
  return ORIGINS[req.query.get("origin") ?? "user"] ?? null;
}

function answer(deps: HttpDeps, facts: StatusFacts, desired: Desired, decision: ControlDecision): FunctionUrlResult {
  const body: ControlAnswer = { ...composeStatus(deps.config, facts, desired), decision };
  return json(202, body);
}

/** Write `d`; when a newer desired state won the race, answer with that one (it is what the tick will act on). */
async function write(deps: HttpDeps, d: Desired): Promise<{ readonly desired: Desired; readonly written: boolean }> {
  const result = await deps.desired.write(d);
  return result === "written" ? { desired: d, written: true } : { desired: await deps.desired.read(), written: false };
}

export async function wakeRoute(deps: HttpDeps, req: Request): Promise<FunctionUrlResult> {
  const key = req.header("idempotency-key");
  if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
    return errorResponse("bad_request", "Idempotency-Key must be 1 to 64 visible ASCII characters");
  }
  const origin = originOf(req);
  if (origin === null) return errorResponse("bad_request", "origin must be user or auto");
  if (key !== undefined) {
    const prior = await deps.idempotency.recall(key);
    if (prior !== null) return prior;
  }

  const now = deps.clock.now();
  const [facts, acceptedAt, breaker] = await Promise.all([
    gatherFacts(deps, now),
    deps.wakeLedger.read(now),
    readBreaker(deps.state),
  ]);
  const decision = decideWake({
    now,
    origin: origin.wake,
    desired: facts.desired,
    frozen: facts.freeze.frozen,
    budget: { ...countWakes(acceptedAt, now), ...deps.config.wakeBudget },
    ...(breaker === null ? {} : { breaker }),
  });

  let result: FunctionUrlResult;
  switch (decision.kind) {
    case "refuse": {
      deps.log.log("info", "wake refused", { code: decision.code, origin: origin.wake });
      if (decision.code === "frozen") return errorResponse("frozen", "The box is frozen; run unfreeze first.");
      const code = decision.code === "budget" ? "wake_budget" : "wake_breaker";
      const message =
        decision.code === "budget"
          ? "The wake budget is used up; try again later."
          : "Unattended wakes are paused after failed wakes; a person's wake still works.";
      return errorResponse(code, message, { retryAfterMs: decision.retryAfterMs ?? 60_000 });
    }
    case "already-awake":
      result = answer(deps, facts, facts.desired, "already-awake");
      break;
    case "accept": {
      const w = await write(deps, decision.desired);
      if (w.written) {
        await deps.wakeLedger.append(now);
        deps.metrics.count("WakeAccepted", { origin: origin.wake });
      }
      deps.log.log("info", "wake accepted", { origin: origin.wake, written: w.written });
      result = answer(deps, facts, w.desired, "accept");
      break;
    }
  }
  if (key !== undefined) await deps.idempotency.remember(key, result);
  return result;
}

export async function parkRoute(deps: HttpDeps, req: Request): Promise<FunctionUrlResult> {
  const origin = originOf(req);
  if (origin === null) return errorResponse("bad_request", "origin must be user or auto");
  const now = deps.clock.now();
  const facts = await gatherFacts(deps, now);
  const w = await write(deps, decidePark(now, origin.park, origin.park));
  deps.log.log("info", "park accepted", { origin: origin.park, written: w.written });
  return answer(deps, facts, w.desired, "accept");
}
