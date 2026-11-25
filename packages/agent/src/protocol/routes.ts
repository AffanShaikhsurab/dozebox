// A2: every endpoint of part 4 §4.3 except `GET /v1/events` (the transport serves the stream). One table of routes;
// each checks its body strictly, calls the store, and answers. Errors become the §4.4 error body.
import { toInstant } from "@dozebox/core/time";
import {
  AttentionInput,
  BeatsInput,
  ERROR_STATUS,
  HealthInput,
  HoldInput,
  Id,
  PresenceInput,
  PROTOCOL_VERSION,
  SleepInput,
  WakeInput,
  type Hello,
  type Status,
} from "@dozebox/protocol/v1";
import { matchesSchema } from "@dozebox/protocol/records";
import { makeAttentionGate } from "./attention.ts";
import { errorBody, ProtocolError } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import type { ProtocolStore } from "./store.ts";
import { checkBody } from "./validate.ts";
import { PAYLOAD_HEADER, type ProtocolHandler, type ProtocolRequest, type ProtocolResponse } from "./wire.ts";

export type ChangeKind = "holds" | "wakes" | "presence" | "beats" | "health";

export type RoutesDeps = {
  readonly store: ProtocolStore;
  readonly now: () => number;
  readonly payloads: () => ReadonlyArray<string>;
  readonly status: (payload: string | null) => Status;
  readonly sleep: (force: boolean) => Promise<{ readonly accepted: boolean; readonly blockers: ReadonlyArray<string> }>;
  readonly attention: (payload: string, input: AttentionInput) => Promise<string>;
  readonly agentVersion: string;
  readonly boxId: string;
  readonly features: ReadonlyArray<string>;
  readonly holdMaxSeconds: (payload: string) => number;
  /** False while the box parks: every write answers 503 shutting_down. */
  readonly accepting: () => boolean;
  /** After every applied write (rec/wakes and rec/liveness follow it). */
  readonly onChange: (what: ChangeKind, payload: string) => void;
};

type Ctx = {
  readonly req: ProtocolRequest;
  readonly payload: string | null;
  readonly id: string;
  readonly now: number;
};
type Route = {
  readonly method: string;
  readonly path: RegExp;
  readonly write: boolean;
  readonly run: (deps: RoutesDeps, c: Ctx) => Promise<ProtocolResponse>;
};

const ok = (body: unknown, status = 200): ProtocolResponse => ({ status, body });
const NO_CONTENT: ProtocolResponse = { status: 204 };

function caller(c: Ctx): string {
  if (c.payload === null) {
    throw new ProtocolError("bad_request", `the admin socket needs the ${PAYLOAD_HEADER} header for this call`, {
      field: PAYLOAD_HEADER,
    });
  }
  return c.payload;
}

function checkId(id: string, payloadWrite: boolean): string {
  if (!matchesSchema(Id, id))
    throw new ProtocolError("invalid_value", "id does not match ^[a-z0-9][a-z0-9._:-]{0,63}$", { field: "id" });
  if (payloadWrite && id.startsWith("src:")) {
    throw new ProtocolError("invalid_value", "ids that start with src: belong to the runner", { field: "id" });
  }
  return id;
}

async function deleted(found: Promise<boolean>, what: string): Promise<ProtocolResponse> {
  if (!(await found)) throw new ProtocolError("not_found", `no ${what} with this id`);
  return NO_CONTENT;
}

const ID = "([^/]+)";
const ROUTES: ReadonlyArray<Route> = [
  { method: "GET", path: /^\/v1\/hello$/, write: false, run: async (d, c) => ok(hello(d, c.payload)) },
  { method: "GET", path: /^\/v1\/status$/, write: false, run: async (d, c) => ok(d.status(c.payload)) },
  {
    method: "PUT",
    path: new RegExp(`^/v1/holds/${ID}$`),
    write: true,
    run: async (d, c) => {
      const p = caller(c);
      const hold = await d.store.putHold(p, checkId(c.id, false), checkBody<HoldInput>(HoldInput, c.req.body), c.now);
      d.onChange("holds", p);
      return ok(hold);
    },
  },
  {
    method: "DELETE",
    path: new RegExp(`^/v1/holds/${ID}$`),
    write: true,
    run: async (d, c) => {
      const p = caller(c);
      const res = await deleted(d.store.deleteHold(p, checkId(c.id, false)), "hold");
      d.onChange("holds", p);
      return res;
    },
  },
  {
    method: "GET",
    path: /^\/v1\/holds$/,
    write: false,
    run: async (d, c) => ok({ holds: d.store.listHolds(c.payload, c.now) }),
  },
  {
    method: "POST",
    path: /^\/v1\/beats$/,
    write: true,
    run: async (d, c) => {
      const p = caller(c);
      await d.store.beats(p, checkBody<BeatsInput>(BeatsInput, c.req.body).beats, c.now);
      d.onChange("beats", p);
      return NO_CONTENT;
    },
  },
  {
    method: "PUT",
    path: new RegExp(`^/v1/wakes/${ID}$`),
    write: true,
    run: async (d, c) => {
      const p = caller(c);
      const wake = await d.store.putWake(p, checkId(c.id, false), checkBody<WakeInput>(WakeInput, c.req.body), c.now);
      d.onChange("wakes", p);
      return ok(wake);
    },
  },
  {
    method: "DELETE",
    path: new RegExp(`^/v1/wakes/${ID}$`),
    write: true,
    run: async (d, c) => {
      const p = caller(c);
      const res = await deleted(d.store.deleteWake(p, checkId(c.id, false)), "wake request");
      d.onChange("wakes", p);
      return res;
    },
  },
  {
    method: "GET",
    path: /^\/v1\/wakes$/,
    write: false,
    run: async (d, c) => ok({ wakes: d.store.listWakes(c.payload, c.now) }),
  },
  {
    method: "PUT",
    path: new RegExp(`^/v1/presence/${ID}$`),
    write: true,
    run: async (d, c) => {
      const p = caller(c);
      const input = checkBody<PresenceInput>(PresenceInput, c.req.body);
      const presence = await d.store.putPresence(p, checkId(c.id, true), input, c.now);
      d.onChange("presence", p);
      return ok(presence);
    },
  },
  {
    method: "DELETE",
    path: new RegExp(`^/v1/presence/${ID}$`),
    write: true,
    run: async (d, c) => {
      const p = caller(c);
      const res = await deleted(d.store.deletePresence(p, checkId(c.id, true)), "presence");
      d.onChange("presence", p);
      return res;
    },
  },
  {
    method: "PUT",
    path: /^\/v1\/health$/,
    write: true,
    run: async (d, c) => {
      const p = caller(c);
      await d.store.putHealth(p, checkBody<HealthInput>(HealthInput, c.req.body), c.now);
      d.onChange("health", p);
      return NO_CONTENT;
    },
  },
  { method: "POST", path: /^\/v1\/sleep$/, write: true, run: (d, c) => sleep(d, c) },
];

function hello(d: RoutesDeps, payload: string | null): Hello {
  return {
    protocol: { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor },
    agent: { version: d.agentVersion },
    box: { id: d.boxId },
    payload: { name: payload ?? "admin" },
    features: [...d.features],
    limits: {
      holdsPerPayload: LIMITS.holdsPerPayload,
      holdMaxSeconds: payload === null ? LIMITS.holdMaxSeconds : d.holdMaxSeconds(payload),
      wakesPerPayload: LIMITS.wakesPerPayload,
      wakeHorizonSeconds: LIMITS.wakeHorizonSeconds,
      presenceMaxSeconds: LIMITS.presenceMaxSeconds,
      attentionPerHour: LIMITS.attentionPerHour,
      beatNamesPerPayload: LIMITS.beatNamesPerPayload,
    },
    deprecations: [],
  };
}

const refuse = (blockers: ReadonlyArray<string>): ProtocolResponse => ({
  status: 409,
  body: {
    error: { code: "conflict", message: "the box cannot sleep now", retryable: false },
    blockers: [...blockers],
  },
});
/** The caller's own holds are released; other payloads' work holds block it unless `force` (part 4 §4.13). */
async function sleep(d: RoutesDeps, c: Ctx): Promise<ProtocolResponse> {
  const input = checkBody<SleepInput>(SleepInput, c.req.body);
  const force = input.force === true;
  const others = (await d.store.holds(c.now)).filter(
    (h) => h.kind === "work" && (c.payload === null || !h.key.startsWith(`${c.payload}/`)),
  );
  if (others.length > 0 && !force) return refuse(others.map((h) => `hold:${h.key}`));
  if (c.payload !== null) {
    for (const h of d.store.listHolds(c.payload, c.now)) await d.store.deleteHold(c.payload, h.id);
    d.onChange("holds", c.payload);
  }
  const answer = await d.sleep(force);
  if (!answer.accepted) return refuse(answer.blockers);
  return { status: 202, body: { parkingAt: toInstant(c.now) } };
}

async function attention(d: RoutesDeps, c: Ctx, gate: ReturnType<typeof makeAttentionGate>): Promise<ProtocolResponse> {
  const p = caller(c);
  const input = checkBody<AttentionInput>(AttentionInput, c.req.body);
  const prior = gate.admit(p, input, c.now);
  if (prior !== null) return ok({ alertId: prior, deduped: true }, 202);
  const alertId = await d.attention(p, input);
  gate.sent(p, input, alertId, c.now);
  return ok({ alertId, deduped: false }, 202);
}

function errorResponse(e: ProtocolError): ProtocolResponse {
  return {
    status: ERROR_STATUS[e.code].status,
    body: errorBody(e.code, e.message, e.field),
    ...(e.retryAfter === undefined ? {} : { headers: { "retry-after": String(e.retryAfter) } }),
  };
}

function payloadOf(d: RoutesDeps, req: ProtocolRequest): string | null {
  if (req.socket.kind === "payload") return req.socket.payload;
  const named = req.headers[PAYLOAD_HEADER];
  if (named === undefined || named === "") return null;
  if (!d.payloads().includes(named)) {
    throw new ProtocolError("invalid_value", `no payload named ${named} on this box`, { field: PAYLOAD_HEADER });
  }
  return named;
}

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function makeRoutes(deps: RoutesDeps): ProtocolHandler {
  const gate = makeAttentionGate();
  const all: ReadonlyArray<Route> = [
    ...ROUTES,
    { method: "POST", path: /^\/v1\/attention$/, write: true, run: (d, c) => attention(d, c, gate) },
  ];
  return async (req) => {
    try {
      if (!req.path.startsWith("/v1/")) throw new ProtocolError("unsupported_version", "this agent serves /v1 only");
      const matching = all.filter((r) => r.path.test(req.path));
      if (matching.length === 0) throw new ProtocolError("not_found", `no endpoint ${req.path}`);
      const route = matching.find((r) => r.method === req.method);
      if (route === undefined) throw new ProtocolError("bad_request", `${req.method} is not allowed on ${req.path}`);
      if (route.write && !deps.accepting()) throw new ProtocolError("shutting_down", "the box is parking");
      const id = decodeId(route.path.exec(req.path)?.[1] ?? "");
      return await route.run(deps, { req, payload: payloadOf(deps, req), id, now: deps.now() });
    } catch (e) {
      if (e instanceof ProtocolError) return errorResponse(e);
      throw e;
    }
  };
}
