// The admin actions of the control function (CR-cli-1, CR-cli-4). Each answers the object the CLI reads from the
// invoke payload; a refusal throws `RunnerError` `invalid_input`, which the CLI sees as a function error.
import { RunnerError } from "@dozebox/core/errors";
import { toInstant } from "@dozebox/core/time";
import type { ControlAnswer, ControlStatus } from "@dozebox/protocol/control";
import type { Deps } from "../deps.ts";
import { parkBox } from "../http/routes/wake.ts";
import { composeStatus, gatherFacts, type StatusFacts } from "../status/build.ts";
import { parseAdminEvent } from "./event.ts";
import { swapVolume, type SwapAnswer } from "./swap.ts";

type RecordRow = { readonly key: string; readonly at: string; readonly writer: unknown };
export type AdminAnswer =
  ControlAnswer | (ControlStatus & { readonly records?: ReadonlyArray<RecordRow> }) | SwapAnswer;

const unsupported = (msg: string): RunnerError => new RunnerError("invalid_input", false, msg);

function parsed(value: string): Readonly<Record<string, unknown>> {
  try {
    const v: unknown = JSON.parse(value);
    return typeof v === "object" && v !== null ? (v as Readonly<Record<string, unknown>>) : {};
  } catch {
    return {};
  }
}

/** The box's `rec/*` records as `{ key, at, writer }`; `at` falls back to the parameter's last write. */
function recordRows(facts: StatusFacts): ReadonlyArray<RecordRow> {
  return [...facts.records.values()]
    .filter((r) => r.name.startsWith("rec/"))
    .map((r) => {
      const v = parsed(r.value);
      return {
        key: r.name,
        at: typeof v["at"] === "string" ? v["at"] : toInstant(r.modifiedAt),
        writer: v["writer"] ?? null,
      };
    });
}

async function status(deps: Deps, records: boolean): Promise<AdminAnswer> {
  const facts = await gatherFacts(deps, deps.clock.now());
  const body = composeStatus(deps.config, facts);
  return records ? { ...body, records: recordRows(facts) } : body;
}

export async function runAdmin(deps: Deps, raw: unknown): Promise<AdminAnswer> {
  const e = parseAdminEvent(raw);
  // Never log the reason text: it is free text from the operator.
  deps.log.log("info", "admin action", { action: e.action });
  switch (e.action) {
    case "park":
      // A park is never refused, so `force` (a person asked) changes nothing here.
      return parkBox(deps, "operator", e.reason === "" ? "operator" : e.reason);
    case "status":
      return status(deps, e.records);
    case "swap-volume":
      return swapVolume(deps, e.volumeId, e.reason);
    case "operator-hold":
      throw unsupported("operator-hold is not supported by the control function yet");
    case "rebuild":
      throw unsupported(
        "rebuild is not run by the control function: use terraform apply -replace on the persistent instance",
      );
  }
}
