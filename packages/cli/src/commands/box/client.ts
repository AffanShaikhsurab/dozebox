import type { DozeboxClient } from "@dozebox/client";
import { DozeboxCliError, type CommandContext } from "../../command.ts";
import { positionals } from "../../output.ts";

/** The agent socket client; null outside a box. */
export function boxClient(ctx: CommandContext): DozeboxClient {
  const client = ctx.deps.agentSocket;
  if (client === null) {
    throw new DozeboxCliError("not-set-up", "not on a box: /run/dozebox/ and DOZEBOX_SOCKET are missing");
  }
  return client;
}

/** The single positional `name`, or a usage error. */
export function oneArg(given: ReadonlyArray<string>, name: string): string {
  const [value] = positionals(given, [name]);
  if (value === undefined) throw new DozeboxCliError("usage", `missing <${name}>`);
  return value;
}

/** A boolean flag value from a values bag. */
export const flag = (values: Readonly<Record<string, unknown>>, name: string): boolean => values[name] === true;

/** Every value of a repeatable string option. */
export function stringsOpt(values: Readonly<Record<string, unknown>>, name: string): ReadonlyArray<string> {
  const v = values[name];
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** An ISO timestamp -> the protocol's Instant, or a usage error. */
export function instantOpt(name: string, text: string): string {
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new DozeboxCliError("usage", `--${name} must be an ISO timestamp, got "${text}"`);
  return new Date(ms).toISOString();
}
