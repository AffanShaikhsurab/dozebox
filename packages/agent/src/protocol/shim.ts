// A2: `dozebox hold` and `dozebox wake-request` on the box (root, through the admin socket). Each is one call:
//   dozebox hold <id> --payload <name> --reason <text> (--for <30m|2h|90s> | --until <instant>) [--wait] [--max <s>]
//   dozebox hold <id> --payload <name> --release
//   dozebox wake-request <id> --payload <name> --reason <text> --at <instant> [--expires <instant>]
//   dozebox wake-request <id> --payload <name> --cancel
import { request } from "node:http";
import { ADMIN_SOCKET } from "./server.ts";
import { PAYLOAD_HEADER } from "./wire.ts";

export type ShimCall = {
  readonly method: "PUT" | "DELETE";
  readonly path: string;
  readonly payload: string;
  readonly body?: Readonly<Record<string, unknown>>;
};

export type ShimAnswer = { readonly status: number; readonly text: string };

const DURATION = /^(\d{1,6})(s|m|h)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

class UsageError extends Error {}

function options(args: ReadonlyArray<string>, flags: ReadonlyArray<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (flags.includes(name)) {
      out.set(name, "true");
      continue;
    }
    const v = args[i + 1];
    if (v === undefined) throw new UsageError(`${a} needs a value`);
    out.set(name, v);
    i++;
  }
  return out;
}

const need = (o: Map<string, string>, k: string): string => {
  const v = o.get(k);
  if (v === undefined) throw new UsageError(`--${k} is required`);
  return v;
};

/** Pure: the protocol call for one shim command line (argv after the program name). */
export function parseShim(argv: ReadonlyArray<string>, now: number): ShimCall {
  const [cmd, id, ...rest] = argv;
  if (id === undefined || id.startsWith("--")) throw new UsageError(`${cmd ?? "dozebox"} needs an id`);
  if (cmd === "hold") {
    const o = options(rest, ["wait", "release"]);
    const payload = need(o, "payload");
    const path = `/v1/holds/${encodeURIComponent(id)}`;
    if (o.has("release")) return { method: "DELETE", path, payload };
    const dur = o.get("for");
    const m = dur === undefined ? null : DURATION.exec(dur);
    if (dur !== undefined && m === null) throw new UsageError("--for takes a duration like 90s, 30m or 2h");
    const until = m
      ? new Date(now + Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS]).toISOString()
      : o.get("until");
    if (until === undefined) throw new UsageError("--for or --until is required");
    const max = o.get("max");
    return {
      method: "PUT",
      path,
      payload,
      body: {
        reason: need(o, "reason"),
        until,
        kind: o.has("wait") ? "wait" : "work",
        ...(max === undefined ? {} : { maxSeconds: Number(max) }),
      },
    };
  }
  if (cmd === "wake-request") {
    const o = options(rest, ["cancel"]);
    const payload = need(o, "payload");
    const path = `/v1/wakes/${encodeURIComponent(id)}`;
    if (o.has("cancel")) return { method: "DELETE", path, payload };
    const expires = o.get("expires");
    return {
      method: "PUT",
      path,
      payload,
      body: { reason: need(o, "reason"), at: need(o, "at"), ...(expires === undefined ? {} : { expiresAt: expires }) },
    };
  }
  throw new UsageError(`unknown command ${cmd ?? ""} (hold, wake-request)`);
}

/** One call on the admin socket. */
export function callAdmin(call: ShimCall, socketPath: string = ADMIN_SOCKET): Promise<ShimAnswer> {
  return new Promise((resolve, reject) => {
    const body = call.body === undefined ? undefined : JSON.stringify(call.body);
    const req = request(
      {
        socketPath,
        method: call.method,
        path: call.path,
        timeout: 2_000,
        headers: {
          [PAYLOAD_HEADER]: call.payload,
          ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("the agent did not answer within 2 s")));
    req.on("error", reject);
    req.end(body);
  });
}

/** The shim's main: prints the answer, exit 0 on 2xx, 2 on a usage error, 1 otherwise. */
export async function shimMain(
  argv: ReadonlyArray<string>,
  io: { readonly out: (s: string) => void; readonly err: (s: string) => void; readonly now: () => number },
  call: (c: ShimCall) => Promise<ShimAnswer> = callAdmin,
): Promise<number> {
  let parsed: ShimCall;
  try {
    parsed = parseShim(argv, io.now());
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(`dozebox: ${e.message}\n`);
    return 2;
  }
  try {
    const answer = await call(parsed);
    (answer.status < 300 ? io.out : io.err)(answer.text === "" ? `${answer.status}\n` : `${answer.text}\n`);
    return answer.status < 300 ? 0 : 1;
  } catch (e) {
    io.err(`dozebox: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
