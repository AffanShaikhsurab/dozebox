import { Type, type Static } from "typebox";

/** Self-reported payload health. Counts until ttlSeconds passes. */
export const HealthInput = Type.Object(
  {
    ok: Type.Boolean(),
    detail: Type.Optional(Type.String({ maxLength: 200 })),
    ttlSeconds: Type.Integer({ minimum: 10, maximum: 3600 }),
  },
  { additionalProperties: false },
);
export type HealthInput = Static<typeof HealthInput>;
