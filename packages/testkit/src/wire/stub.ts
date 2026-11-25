// Offline SDK v3 clients for adapter unit tests: a middleware at the front of the client's stack answers every send
// from a reply function, before credentials, endpoints or the network are touched. Imports no SDK: it works on the
// `middlewareStack` every v3 client has.
import { readFileSync } from "node:fs";

type Handler = (args: { readonly input?: unknown }) => Promise<unknown>;
type Stack = {
  readonly add: (
    middleware: (next: Handler, context: { readonly commandName?: string }) => Handler,
    options: { readonly step: "initialize"; readonly name: string; readonly priority?: "high" },
  ) => void;
};

export const stackOf = (client: object): Stack => (client as { readonly middlewareStack: Stack }).middlewareStack;

/** Config for a client that must never reach anything: loopback port 9 (discard), fake keys, one attempt. */
export const OFFLINE_CONFIG = {
  region: "us-east-1",
  endpoint: "http://127.0.0.1:9",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 1,
} as const;

/** An error shaped like the SDK's service exceptions: `name` is the AWS error code. */
export function awsFault(name: string, status: number, message = `stubbed ${name}`): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: status >= 500 ? "server" : "client",
    $metadata: { httpStatusCode: status },
  });
}

export type SentCall = { readonly command: string; readonly input: Readonly<Record<string, unknown>> };

/** Answer for one send: the command's output object, or throw (use `awsFault`). */
export type StubReply = (command: string, input: Readonly<Record<string, unknown>>, n: number) => unknown;

export type SdkStub = {
  /** Every send so far, in order. */
  readonly calls: ReadonlyArray<SentCall>;
  /** The sends of one command, such as "CreateTagsCommand". */
  readonly sent: (command: string) => ReadonlyArray<Readonly<Record<string, unknown>>>;
};

/**
 * Answer every send of `client` from `reply`. `n` counts the sends of that command so far (0 first), for paging and
 * for "not visible yet, then visible" reads. A reply that returns undefined fails the send, so a test notices a call
 * it did not expect.
 */
export function stubSdk(client: object, reply: StubReply): SdkStub {
  const calls: SentCall[] = [];
  const counts = new Map<string, number>();
  stackOf(client).add(
    (_next, context) => async (args) => {
      const command = context.commandName ?? "UnknownCommand";
      const input = (args.input ?? {}) as Readonly<Record<string, unknown>>;
      const n = counts.get(command) ?? 0;
      counts.set(command, n + 1);
      calls.push({ command, input });
      const output = await reply(command, input, n);
      if (output === undefined) throw new Error(`stubSdk: no reply for ${command} #${n}`);
      return { output: { $metadata: { httpStatusCode: 200 }, ...(output as object) }, response: {} };
    },
    { step: "initialize", name: "dozeboxStubSdk", priority: "high" },
  );
  return {
    calls,
    sent: (command) => calls.filter((c) => c.command === command).map((c) => c.input),
  };
}

const DATE_KEYS = /(Time|Date)$/;

/**
 * A recorded (redacted) SDK response from `fixtures/aws/<name>.json`, with ISO strings in `*Time` and `*Date` keys
 * turned back into Date objects, as the SDK returns them.
 */
export function awsFixture(name: string): unknown {
  const url = new URL(`../../fixtures/aws/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"), (key, value: unknown) =>
    DATE_KEYS.test(key) && typeof value === "string" ? new Date(value) : value,
  );
}
