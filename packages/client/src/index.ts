// P2: the payload client library (part 4 §4.17). Zero runtime dependencies besides @dozebox/protocol.
import { makeClient } from "./client.ts";
import type { DozeboxClient, DozeboxClientOptions } from "./types.ts";

export { DozeboxError, type DozeboxErrorCode } from "./http.ts";
export type { DozeboxClient, DozeboxClientOptions, DozeboxEvent } from "./types.ts";

/** A client, or null when not running on a box (DOZEBOX_SOCKET unset and no `socketPath`). */
export function createClient(opts?: DozeboxClientOptions): DozeboxClient | null {
  const socketPath = opts?.socketPath || process.env["DOZEBOX_SOCKET"];
  if (!socketPath) return null;
  return makeClient({ socketPath, timeoutMs: opts?.timeoutMs, signal: opts?.signal });
}
