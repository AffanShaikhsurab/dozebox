import { Type, type Static } from "typebox";

export const Feature = Type.String({ pattern: "^[a-z][a-z0-9-]{0,40}$" });
export type Feature = Static<typeof Feature>;

export const Hello = Type.Object({
  protocol: Type.Object({ major: Type.Literal(1), minor: Type.Integer({ minimum: 0 }) }),
  agent: Type.Object({ version: Type.String() }),
  box: Type.Object({ id: Type.String() }),
  payload: Type.Object({ name: Type.String() }),
  /** Optional features this agent supports, e.g. "wake-on-github", "presence-kinds". */
  features: Type.Array(Feature),
  limits: Type.Object({
    holdsPerPayload: Type.Integer(),
    holdMaxSeconds: Type.Integer(),
    wakesPerPayload: Type.Integer(),
    wakeHorizonSeconds: Type.Integer(),
    presenceMaxSeconds: Type.Integer(),
    attentionPerHour: Type.Integer(),
    beatNamesPerPayload: Type.Integer(),
  }),
  deprecations: Type.Array(
    Type.Object({
      what: Type.String(),
      since: Type.String(),
      removedIn: Type.String(),
      replacement: Type.Optional(Type.String()),
    }),
  ),
});
export type Hello = Static<typeof Hello>;
