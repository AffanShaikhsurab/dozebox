// Box config (part 5 §5.4): the advanced SSM parameter /<prefix>/<box>/config, rendered by Terraform and read by
// the agent at boot and every 5 minutes. And the operator's .dozebox/stack.json.
import { Type, type Static } from "typebox";

const Strict = { additionalProperties: false } as const;
const Percent = Type.Number({ minimum: 0, maximum: 100 });
const PositiveInt = Type.Integer({ minimum: 1 });
const PayloadName = Type.String({ pattern: "^[a-z][a-z0-9-]{0,30}$" });
const BoxId = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,19}$" });
const Prefix = Type.String({ pattern: "^[a-z][a-z0-9-]{0,20}$" });
const Region = Type.String({ pattern: "^[a-z]{2}(-[a-z]+)+-\\d$" });

export const BoxConfig = Type.Object(
  {
    schema: Type.Literal(1),
    box: Type.Object({ id: BoxId, prefix: Prefix, region: Region }, Strict),
    /** Words shown in alerts and the status summary. The runner names no payload itself. */
    brand: Type.Object(
      { name: Type.String({ minLength: 1, maxLength: 60 }), alertSubject: Type.String({ maxLength: 120 }) },
      Strict,
    ),
    idle: Type.Object(
      {
        idleMinutes: Type.Integer({ minimum: 5, maximum: 1440 }),
        viewingGraceMinutes: Type.Integer({ minimum: 0, maximum: 1440 }),
        noProgressParkMinutes: Type.Integer({ minimum: 5, maximum: 10080 }),
      },
      Strict,
    ),
    health: Type.Object(
      {
        checkEverySeconds: Type.Integer({ minimum: 10, maximum: 3600 }),
        restartAtStrikes: Type.Array(PositiveInt, { maxItems: 8 }),
        parkAtStrikes: PositiveInt,
        restartsPerHour: Type.Integer({ minimum: 0, maximum: 60 }),
      },
      Strict,
    ),
    failsafe: Type.Object({ bootDeadlineMinutes: PositiveInt, everyMinutes: PositiveInt }, Strict),
    caps: Type.Object(
      { awakeHoursPerDay: Type.Union([Type.Number({ minimum: 0, maximum: 24 }), Type.Null()]) },
      Strict,
    ),
    disk: Type.Object({ lowPct: Percent, criticalPct: Percent, hysteresisPct: Percent }, Strict),
    alerts: Type.Object(
      {
        topicArn: Type.String({ pattern: "^arn:aws[a-z-]*:sns:[a-z0-9-]+:\\d{12}:[A-Za-z0-9_-]{1,256}$" }),
        dedupeSeconds: Type.Integer({ minimum: 0, maximum: 86400 }),
      },
      Strict,
    ),
    logs: Type.Object(
      { group: Type.String({ pattern: "^[A-Za-z0-9_/.#-]{1,512}$" }), dailyBudgetMiB: Type.Integer({ minimum: 0 }) },
      Strict,
    ),
    presenceSources: Type.Object(
      { ssh: Type.Boolean(), tcpPorts: Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), { maxItems: 8 }) },
      Strict,
    ),
    jail: Type.Object(
      {
        enabled: Type.Boolean(),
        egress: Type.Union([Type.Literal("imds-only"), Type.Literal("allowlist"), Type.Literal("off")]),
        allowHosts: Type.Array(Type.String({ maxLength: 253 }), { maxItems: 64 }),
      },
      Strict,
    ),
    tripwire: Type.Object({ enabled: Type.Boolean() }, Strict),
    /** Names of the payload definitions under /<prefix>/<box>/payloads/<name>. */
    payloads: Type.Array(PayloadName, { maxItems: 4 }),
  },
  Strict,
);
export type BoxConfig = Static<typeof BoxConfig>;

/** `.dozebox/stack.json`, written by `dozebox init` and `setup`. */
export const OperatorConfig = Type.Object(
  {
    schema: Type.Literal(1),
    box: BoxId,
    region: Region,
    terraformDir: Type.String({ minLength: 1 }),
    outputs: Type.Object({
      control_url: Type.String(),
      control_function_name: Type.String(),
      ssm_prefix: Type.String(),
      state_table_name: Type.String(),
    }),
  },
  Strict,
);
export type OperatorConfig = Static<typeof OperatorConfig>;
