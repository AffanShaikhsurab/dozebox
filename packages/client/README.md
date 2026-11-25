# @dozebox/client

Node client for a payload running on a dozebox box. It talks HTTP/1.1 over the payload's unix socket, retries only
errors the agent marks retryable, and reads responses tolerantly (extra fields and unknown enum values do not throw).
No runtime dependency besides `@dozebox/protocol`.

```ts
import { createClient } from "@dozebox/client";

const dozebox = createClient(); // null when DOZEBOX_SOCKET is unset (a laptop)
if (dozebox) {
  const work = dozebox.keepHold("run-42", { reason: "run 42: implement", forSeconds: 300 });
  // ... do the work ...
  await work.stop();
}
```

## Public surface

- `createClient(opts?)`: `DozeboxClient | null`. `opts.socketPath` defaults to `DOZEBOX_SOCKET`; `opts.timeoutMs`
  (default 2000) bounds each attempt; `opts.signal` aborts calls and the event stream.
- `DozeboxClient`: `hello`, `status`, `hold`, `release`, `keepHold`, `beat`, `wake`, `cancelWake`, `presence`,
  `attention`, `sleep`, `events`.
- `keepHold(id, { reason, forSeconds, renewEverySeconds?, kind? })` renews the hold to now + `forSeconds` every
  `renewEverySeconds` (default a third of `forSeconds`) until `stop()`, which releases it.
- `sleep()` returns `{ accepted: false, blockers }` when the agent answers 409 `SleepRefused`.
- `events(onEvent)` is an SSE stream that reconnects with `Last-Event-ID`; unknown event names arrive as
  `{ type: "unknown", name, data }`. `close()` stops it.
- `DozeboxError` has `code` (an agent error code or `"transport"`), `status`, and `retryable`. A call is tried up to 3
  times, with jittered backoff, and only when `retryable` is true.
