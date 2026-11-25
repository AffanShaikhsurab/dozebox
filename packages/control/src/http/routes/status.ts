// GET /v1/status (part 5 §5.3) and POST /v1/alerts/test.
import { Type } from "typebox";
import Value from "typebox/value";
import { composeStatus, gatherFacts } from "../../status/build.ts";
import { KEYS } from "../../state/keys.ts";
import type { FunctionUrlResult, Request } from "../event.ts";
import { errorResponse, json } from "../respond.ts";
import type { HttpDeps } from "../types.ts";

export async function statusRoute(deps: HttpDeps, _req: Request): Promise<FunctionUrlResult> {
  const facts = await gatherFacts(deps, deps.clock.now());
  return json(200, composeStatus(deps.config, facts));
}

const AlertsTestInput = Type.Object(
  { severity: Type.Optional(Type.Union([Type.Literal("page"), Type.Literal("notify")])) },
  { additionalProperties: false },
);

/** One test alert a minute, so a held-down button cannot flood the operator's phone. */
const ALERTS_TEST_EVERY_S = 60;

/**
 * Send one message through the alert topic, so the operator can see the alert path works end to end. The alert
 * sinks (ntfy, Web Push, webhook) arrive in C4; until then the topic (e-mail) is the whole path.
 */
export async function alertsTestRoute(deps: HttpDeps, req: Request): Promise<FunctionUrlResult> {
  let input: unknown = {};
  if (req.body.trim() !== "") {
    try {
      input = JSON.parse(req.body);
    } catch {
      return errorResponse("bad_request", "the body is not JSON");
    }
  }
  if (!Value.Check(AlertsTestInput, input)) {
    return errorResponse("bad_request", 'the body must be {"severity":"page"|"notify"}');
  }
  const severity = input.severity ?? "notify";
  const now = deps.clock.now();
  if ((await deps.state.putIfAbsent(KEYS.alertsTest, { at: now }, ALERTS_TEST_EVERY_S)) === "exists") {
    return errorResponse("rate_limited", "One test alert a minute.", { retryAfterMs: ALERTS_TEST_EVERY_S * 1000 });
  }
  const box = deps.config.box.id;
  const messageId = await deps.notifier.publish({
    subject: `Test alert from ${box}`,
    body: `This is a test ${severity} alert from the box ${box}. If you can read it, the alert path works.`,
    attributes: { severity, kind: "test" },
  });
  deps.log.log("info", "test alert sent", { severity });
  return json(202, { v: 1, sent: true, severity, messageId });
}
