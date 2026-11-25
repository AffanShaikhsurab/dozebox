// The Lambda entry (`control.handler` in the bundle, part 6 §6.1): route by event shape. HTTP from the Function URL
// goes to the router; the Scheduler's `{"dozebox":"reconcile","v":1}` runs one tick; raw `aws.ec2` events only write
// a record (R1). A CLI admin event runs one admin action. Anything else is a wiring bug and throws, so it lands in the
// dead-letter queue.
// The dependencies are built on the first invocation, not at import, so a bad DOZEBOX_CONTROL answers HTTP with 500
// and a log line naming the field instead of failing every cold start without a word.
import { isAdminEvent } from "./admin/event.ts";
import { runAdmin, type AdminAnswer } from "./admin/run.ts";
import { makeDeps, type Deps } from "./deps.ts";
import { isEc2Event, onEc2Event } from "./events/ec2.ts";
import { isHttpEvent, type FunctionUrlResult } from "./http/event.ts";
import { errorResponse } from "./http/respond.ts";
import { route } from "./http/router.ts";
import { tick } from "./reconcile/tick.ts";

export type LambdaContext = { readonly awsRequestId?: string };

export function isScheduleEvent(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const o = e as { readonly dozebox?: unknown; readonly v?: unknown };
  return o.dozebox === "reconcile" && o.v === 1;
}

export type Handler = (event: unknown, context?: LambdaContext) => Promise<FunctionUrlResult | AdminAnswer | void>;

export function makeHandler(build: () => Deps): Handler {
  let deps: Deps | null = null;
  return async (event, context) => {
    if (deps === null) {
      try {
        deps = build();
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : "unknown";
        process.stdout.write(
          `${JSON.stringify({ level: "error", msg: "control function misconfigured", component: "control", error: msg })}\n`,
        );
        if (isHttpEvent(event)) return errorResponse("internal", "The control function is misconfigured.");
        throw e;
      }
    }
    deps.setRequestId(context?.awsRequestId);
    if (isHttpEvent(event)) return route(deps, event);
    if (isScheduleEvent(event)) return void (await tick(deps, { trigger: "schedule" }));
    if (isAdminEvent(event)) return runAdmin(deps, event);
    if (isEc2Event(event)) {
      const out = await onEc2Event(deps, event);
      deps.log.log("info", "ec2 event", { kept: out.kept, why: out.why });
      return;
    }
    deps.log.log("error", "unknown event shape");
    throw new Error("unknown event shape");
  };
}

export const handler: Handler = makeHandler(() => makeDeps(process.env));
