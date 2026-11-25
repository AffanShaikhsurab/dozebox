// A stubbed SDK v3 client answered by per-command handlers (W3 style; `stub.ts` is the reply-function style W2 uses) for offline adapter tests: every send is answered by a handler registered for its command
// name (such as "PutParameterCommand"), before anything is signed or goes on the wire. A command with no handler
// fails the test, so an offline test can never reach a real endpoint. Imports no SDK; it uses the client's
// middleware stack, the same seam `faultInjector` uses.

/** One send the stub answered: the command name and the input the adapter built. */
export type SdkCall = { readonly command: string; readonly input: Readonly<Record<string, unknown>> };

/** Returns the command's output (without `$metadata`), or throws to fail the call. */
export type SdkHandler = (input: Readonly<Record<string, unknown>>) => unknown;

export type HandlerStub = {
  /** Every send so far, in order. */
  readonly calls: ReadonlyArray<SdkCall>;
  /** Inputs of one command, in order. */
  readonly inputs: (command: string) => ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** Answer every later send of `command` with `handler`. */
  readonly on: (command: string, handler: SdkHandler) => void;
  /** The next send of `command` throws an error shaped like the SDK's service exceptions. */
  readonly fail: (command: string, name: string, status: number, message?: string) => void;
};

type Handler = (args: unknown) => Promise<unknown>;
type Stack = {
  readonly add: (
    middleware: (next: Handler, context: { readonly commandName?: string }) => Handler,
    options: { readonly step: "initialize"; readonly name: string; readonly priority: "high" },
  ) => void;
};

/** An error shaped like an SDK v3 service exception (`name`, `$fault`, `$metadata.httpStatusCode`). */
export function sdkError(name: string, status: number, message = `stubbed ${name}`): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: status >= 500 ? "server" : "client",
    $metadata: { httpStatusCode: status },
  });
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null;

export function stubHandlers(client: object): HandlerStub {
  const calls: SdkCall[] = [];
  const handlers = new Map<string, SdkHandler>();
  const faults = new Map<string, Error[]>();
  const stack = (client as { readonly middlewareStack: Stack }).middlewareStack;
  stack.add(
    (_next, context) => async (args) => {
      const command = context.commandName ?? "unknown";
      const input = isRecord(args) && isRecord(args["input"]) ? args["input"] : {};
      calls.push({ command, input: structuredClone(input) });
      const fault = faults.get(command)?.shift();
      if (fault) throw fault;
      const handler = handlers.get(command);
      if (!handler) throw new Error(`stubSdk: no handler for ${command}`);
      const output = await handler(input);
      return { output: { ...(isRecord(output) ? output : {}), $metadata: { httpStatusCode: 200 } } };
    },
    { step: "initialize", name: "dozeboxStubSdk", priority: "high" },
  );
  return {
    calls,
    inputs: (command) => calls.filter((c) => c.command === command).map((c) => c.input),
    on: (command, handler) => {
      handlers.set(command, handler);
    },
    fail: (command, name, status, message) => {
      const list = faults.get(command) ?? [];
      list.push(sdkError(name, status, message));
      faults.set(command, list);
    },
  };
}

/** Client config for an offline test: fake keys, a closed loopback port, no retries. */
export const offlineConfig = {
  region: "us-east-1",
  endpoint: "http://127.0.0.1:9",
  credentials: { accessKeyId: "offline", secretAccessKey: "offline" },
  maxAttempts: 1,
} as const;
