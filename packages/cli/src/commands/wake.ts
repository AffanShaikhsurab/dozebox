// `dozebox wake`: `POST /v1/wake?origin=user`; `--wait` polls until the box serves (or `--until running`).
// The wake budget answers exit 75 with the retry time, a freeze exit 5.
import { SECOND } from "@dozebox/core/time";
import { DozeboxCliError, EXIT, type Command } from "../command.ts";
import { statusLines } from "../format/status.ts";
import { intOpt, say, stringOpt } from "../output.ts";

const DEFAULT_TIMEOUT_S = 900;

export const wake: Command = {
  name: "wake",
  summary: "Wake the box and optionally wait until it serves.",
  options: { wait: { type: "boolean" }, until: { type: "string" }, timeout: { type: "string" } },
  mode: "operator",
  mutates: true,
  run: async (ctx, values) => {
    const until = stringOpt(values, "until") ?? "serving";
    if (until !== "serving" && until !== "running") throw new DozeboxCliError("usage", "--until is serving or running");
    const timeoutS = intOpt(values, "timeout", DEFAULT_TIMEOUT_S);
    const { control, clock, ids } = ctx.deps;
    const answer = await control.wake({ idempotencyKey: ids.random(), origin: "user" });
    if (answer.kind === "budget") {
      throw new DozeboxCliError("try-later", `The wake budget is used up; try again in ${answer.retryAfterSeconds} s.`);
    }
    if (answer.kind === "frozen") throw new DozeboxCliError("refused", "The box is frozen; run `dozebox unfreeze`.");
    say(ctx, values, `Wake accepted: ${answer.status.state}.`);
    if (values["wait"] !== true) return { exitCode: EXIT.ok, json: answer.status };

    say(ctx, values, `Waiting until ${until} (up to ${timeoutS} s)...`);
    const deadline = clock.timeout(timeoutS * SECOND);
    try {
      const done = await control.waitFor(until, AbortSignal.any([ctx.signal, deadline]));
      for (const l of statusLines(done)) say(ctx, values, l);
      return { exitCode: EXIT.ok, json: done };
    } catch (e) {
      if (deadline.aborted && !ctx.signal.aborted) {
        throw new DozeboxCliError("problem", `Not ${until} after ${timeoutS} s; see \`dozebox status\`.`, { cause: e });
      }
      throw e;
    }
  },
};
