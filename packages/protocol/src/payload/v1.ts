// Payload definition (part 5 §5.5, plugin point 1). A payload is data: how to install, start, check, snapshot
// and jail it. Hooks are argv arrays, so a payload in any language can define them.
import { Type, type Static } from "typebox";

const Argv = Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 64 });
const Hook = Type.Object(
  { command: Argv, timeoutSeconds: Type.Integer({ minimum: 1, maximum: 3600 }) },
  { additionalProperties: false },
);
const EnvName = Type.String({ pattern: "^[A-Z_][A-Z0-9_]{0,63}$" });
const Port = Type.Integer({ minimum: 1, maximum: 65535 });

export const PayloadDefinition = Type.Object(
  {
    schema: Type.Literal(1),
    name: Type.String({ pattern: "^[a-z][a-z0-9-]{0,30}$" }),
    description: Type.Optional(Type.String({ maxLength: 200 })),
    /** Linux user the payload runs as. Created if missing. Never root. */
    user: Type.String({ pattern: "^(?!root$)[a-z_][a-z0-9_-]{0,31}$" }),
    /** "v1": speaks the protocol. "none": health-only mode. */
    protocol: Type.Union([Type.Literal("v1"), Type.Literal("none")]),
    install: Type.Optional(
      Type.Object(
        {
          command: Argv,
          /** "every-boot", "once" (first boot of a volume), or "on-change" (when this object's hash changes). */
          when: Type.Union([Type.Literal("every-boot"), Type.Literal("once"), Type.Literal("on-change")]),
          timeoutSeconds: Type.Integer({ minimum: 10, maximum: 3600 }),
          asRoot: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    start: Type.Object(
      {
        command: Argv,
        workingDirectory: Type.Optional(Type.String()),
        env: Type.Optional(Type.Record(EnvName, Type.String({ maxLength: 4096 }))),
        stopGraceSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 600 })),
        /** Default true. A payload that launches jailed agents needs sudo, which NoNewPrivileges blocks. */
        noNewPrivileges: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    health: Type.Optional(
      Type.Object(
        {
          http: Type.Optional(
            Type.Object(
              {
                url: Type.String({ pattern: "^http://(127\\.0\\.0\\.1|localhost|\\[::1\\])" }),
                expectStatus: Type.Optional(Type.Integer()),
              },
              { additionalProperties: false },
            ),
          ),
          command: Type.Optional(Argv),
          timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
          /** How long after start before failures count. */
          startPeriodSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 3600 })),
        },
        { additionalProperties: false },
      ),
    ),
    activity: Type.Optional(
      Type.Object(
        {
          cpuPercent: Type.Optional(Type.Number({ minimum: 0.5, maximum: 100 })),
          tcpPorts: Type.Optional(Type.Array(Port, { maxItems: 8 })),
        },
        { additionalProperties: false },
      ),
    ),
    limits: Type.Optional(
      Type.Object(
        {
          holdMaxSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 86400 })),
          memoryMax: Type.Optional(Type.String({ pattern: "^[0-9]+[KMG]$|^[0-9]{1,3}%$" })),
          cpuWeight: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
        },
        { additionalProperties: false },
      ),
    ),
    data: Type.Optional(
      Type.Object(
        {
          /** Paths under /data/payloads/<name> that matter for restores, e.g. databases. */
          critical: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
          /** Run before a snapshot (flush, copy SQLite with .backup); must finish in timeoutSeconds. */
          preSnapshot: Type.Optional(Hook),
          postSnapshot: Type.Optional(Hook),
          /** Proof a restore worked. Exit 0 = good. */
          verifyRestore: Type.Optional(Hook),
        },
        { additionalProperties: false },
      ),
    ),
    secrets: Type.Optional(
      Type.Array(
        Type.Object(
          {
            /** Name under /<prefix>/shared/ (SecureString). */
            name: Type.String({ pattern: "^[a-z0-9-]{1,40}$" }),
            /** Delivered as a 0600 file under $CREDENTIALS_DIRECTORY (systemd LoadCredential), or as an env var. */
            as: Type.Union([
              Type.Object({ file: Type.String({ pattern: "^[a-z0-9._-]{1,60}$" }) }, { additionalProperties: false }),
              Type.Object({ env: EnvName }, { additionalProperties: false }),
            ]),
            optional: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        { maxItems: 32 },
      ),
    ),
    jail: Type.Optional(
      Type.Object(
        {
          /** Agents launched with `dozebox jail exec` get this profile. */
          readOnlyPaths: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
          writablePaths: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
          hidePaths: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
        },
        { additionalProperties: false },
      ),
    ),
    /** Ports the payload listens on that the network needs open (outbound tunnels need none). */
    ports: Type.Optional(Type.Array(Port, { maxItems: 8 })),
  },
  { additionalProperties: false },
);
export type PayloadDefinition = Static<typeof PayloadDefinition>;

/** The env every payload gets; a definition cannot override these. */
export const RESERVED_ENV = [
  "DOZEBOX_SOCKET",
  "DOZEBOX_PAYLOAD",
  "DOZEBOX_BOX_ID",
  "DOZEBOX_PROTOCOL",
  "DOZEBOX_DATA_DIR",
  "DOZEBOX_STATUS_FILE",
] as const;
