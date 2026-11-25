// The wake token: 32 random bytes, base64url (43 characters), stored as a SecureString at `wake_token_parameter`.
import { randomBytes } from "node:crypto";
import type { AwsOps } from "./ports/aws.ts";
import type { StackContext } from "./stack.ts";

export const newWakeToken = (): string => randomBytes(32).toString("base64url");

/** The wake link the phone and the wake page use; the token rides in the fragment, never in a query string. */
export const wakeLink = (controlUrl: string, token: string): string => `${controlUrl}/#t=${token}`;

/** Stores a new token when none is stored. Returns true when it wrote one. */
export async function ensureWakeToken(aws: AwsOps, stack: StackContext): Promise<boolean> {
  const current = await aws.getParameter(stack.wakeTokenParameter);
  if (current !== null && current !== "") return false;
  await aws.putParameter(stack.wakeTokenParameter, newWakeToken(), { secure: true });
  return true;
}
