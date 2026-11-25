// The Lambda Function URL event (payload format 2.0) and its result, typed to the fields the router reads. The event
// is untrusted input: every field is checked before use, and anything else in it is ignored.

export type FunctionUrlEvent = {
  readonly rawPath: string;
  readonly rawQueryString?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext: {
    readonly requestId?: string;
    readonly http: { readonly method: string; readonly path?: string; readonly sourceIp?: string };
  };
};

export type FunctionUrlResult = {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly isBase64Encoded?: boolean;
};

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null;

/** A Function URL (or API Gateway v2) HTTP event: `requestContext.http.method` and `rawPath` are strings. */
export function isHttpEvent(e: unknown): e is FunctionUrlEvent {
  if (!isObject(e) || typeof e["rawPath"] !== "string") return false;
  const ctx = e["requestContext"];
  if (!isObject(ctx)) return false;
  const http = ctx["http"];
  return isObject(http) && typeof http["method"] === "string";
}

/** The request as the routes see it: method upper case, path without a trailing slash, headers lower case. */
export type Request = {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly header: (name: string) => string | undefined;
  /** The body as text (base64 decoded), or "" when there is none. */
  readonly body: string;
  readonly requestId: string | undefined;
};

export function toRequest(e: FunctionUrlEvent): Request {
  const headers = new Map<string, string>();
  for (const [k, v] of Object.entries(e.headers ?? {})) if (typeof v === "string") headers.set(k.toLowerCase(), v);
  const raw = e.rawPath.length > 1 ? e.rawPath.replace(/\/+$/, "") : e.rawPath;
  const body = typeof e.body === "string" ? e.body : "";
  return {
    method: e.requestContext.http.method.toUpperCase(),
    path: raw === "" ? "/" : raw,
    query: new URLSearchParams(typeof e.rawQueryString === "string" ? e.rawQueryString : ""),
    header: (name) => headers.get(name.toLowerCase()),
    body: e.isBase64Encoded === true ? Buffer.from(body, "base64").toString("utf8") : body,
    requestId: e.requestContext.requestId,
  };
}
