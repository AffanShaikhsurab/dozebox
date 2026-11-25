// The control function's view of its stack: the `DOZEBOX_CONTROL` JSON Terraform renders (terraform/control.tf).
// Checked once per container with TypeBox; extra fields are allowed, so a newer module can add keys before the code
// reads them. A missing or invalid value is a deploy bug: every request then answers 500 and logs why.
import { Type, type Static } from "typebox";
import Value from "typebox/value";

const NullableNumber = Type.Union([Type.Number(), Type.Null()]);
const NullableString = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

export const ControlConfig = Type.Object({
  v: Type.Literal(1),
  box: Type.Object({
    id: Type.String({ minLength: 1 }),
    prefix: Type.String({ minLength: 1 }),
    region: Type.String({ minLength: 1 }),
  }),
  /** The box root in SSM, such as `/dozebox/main/` (starts and ends with `/`). */
  ssmPrefix: Type.String({ pattern: "^/.+/$" }),
  stateTable: Type.String({ minLength: 1 }),
  alertTopicArn: Type.String({ minLength: 1 }),
  groups: Type.Object({ spot: NullableString, fallback: NullableString }),
  metrics: Type.Object({ namespace: Type.String({ minLength: 1 }) }),
  caps: Type.Object({
    awakeHoursPerDay: NullableNumber,
    onDemandHoursPerDay: NullableNumber,
    monthlyBudgetUsd: Type.Number(),
    budgetName: Type.String({ minLength: 1 }),
  }),
  fallback: Type.Object({ enabled: Type.Boolean(), unattended: Type.Boolean() }),
  wakeBudget: Type.Object({ perHour: Type.Integer({ minimum: 0 }), perDay: Type.Integer({ minimum: 0 }) }),
  kill: Type.Object({ freezeParameter: Type.String({ minLength: 1 }) }),
  /** Token header aliases accepted besides `x-dozebox-token` while clients migrate (part 9 §9.2.6, until 2.0). */
  http: Type.Optional(Type.Object({ tokenHeaders: Type.Array(Type.String({ pattern: "^[a-z0-9-]{1,64}$" })) })),
});
export type ControlConfig = Static<typeof ControlConfig>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Parse `DOZEBOX_CONTROL`. Throws ConfigError naming the first bad field (never the value). */
export function parseControlConfig(raw: string | undefined): ControlConfig {
  if (raw === undefined || raw.trim() === "") throw new ConfigError("DOZEBOX_CONTROL is not set");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ConfigError("DOZEBOX_CONTROL is not JSON");
  }
  if (!Value.Check(ControlConfig, value)) {
    const first = [...Value.Errors(ControlConfig, value)][0];
    throw new ConfigError(`DOZEBOX_CONTROL is invalid at ${first?.instancePath || "/"}: ${first?.message ?? "?"}`);
  }
  return value;
}

/** A parameter name relative to the box root, such as `freeze` for `/dozebox/main/freeze`. */
export function relativeParameter(cfg: ControlConfig, full: string): string {
  return full.startsWith(cfg.ssmPrefix) ? full.slice(cfg.ssmPrefix.length) : full.replace(/^\/+/, "");
}
