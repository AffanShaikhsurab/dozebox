// The admin event the CLI sends with `lambda invoke` (packages/cli ports/control.ts `AdminEvent`):
// `{ dozebox: "admin", v: 1, action, ... }`. Validated here; a bad event is `invalid_input`, which the CLI sees as a
// function error carrying the message.
import { RunnerError } from "@dozebox/core/errors";
import { Type, type Static } from "typebox";
import Value from "typebox/value";

const Reason = Type.String({ maxLength: 200 });
const base = { dozebox: Type.Literal("admin"), v: Type.Literal(1) };

export const AdminEvent = Type.Union([
  Type.Object({ ...base, action: Type.Literal("park"), force: Type.Boolean(), reason: Reason }),
  Type.Object({
    ...base,
    action: Type.Literal("operator-hold"),
    forSeconds: Type.Integer({ minimum: 1 }),
    reason: Reason,
  }),
  Type.Object({ ...base, action: Type.Literal("status"), records: Type.Boolean() }),
  Type.Object({
    ...base,
    action: Type.Literal("swap-volume"),
    volumeId: Type.String({ minLength: 1 }),
    reason: Reason,
  }),
  Type.Object({ ...base, action: Type.Literal("rebuild"), reason: Reason }),
]);
export type AdminEvent = Static<typeof AdminEvent>;
const ACTIONS: ReadonlyArray<string> = ["park", "operator-hold", "status", "swap-volume", "rebuild"];

export function isAdminEvent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { readonly dozebox?: unknown }).dozebox === "admin";
}

export function parseAdminEvent(e: unknown): AdminEvent {
  const action = (e as { readonly action?: unknown }).action;
  if (typeof action !== "string" || !ACTIONS.includes(action)) {
    throw new RunnerError("invalid_input", false, `unknown admin action: ${String(action).slice(0, 40)}`);
  }
  if (!Value.Check(AdminEvent, e)) {
    const first = Value.Errors(AdminEvent, e).find((x) => x.instancePath !== "" || x.keyword !== "anyOf");
    const where = first?.instancePath ?? "";
    throw new RunnerError("invalid_input", false, `bad admin ${action} event${where === "" ? "" : ` at ${where}`}`);
  }
  return e;
}
