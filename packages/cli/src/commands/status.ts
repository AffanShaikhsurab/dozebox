// `dozebox status` (operator): the control function's `/v1/status`; `--records` and `--releases` add the box records
// through the admin `status` event; `--watch` prints again on every change until Ctrl-C.
import { SECOND } from "@dozebox/core/time";
import { EXIT, type Command, type CommandContext } from "../command.ts";
import { recordLines, recordRows, statusLines, type RecordRow } from "../format/status.ts";
import { isJson, say, type Values } from "../output.ts";

const WATCH_EVERY_MS = 10 * SECOND;

async function once(ctx: CommandContext, values: Values) {
  const status = await ctx.deps.control.status(ctx.signal);
  const wantRecords = values["records"] === true || values["releases"] === true;
  let rows: ReadonlyArray<RecordRow> = [];
  if (wantRecords) {
    rows = recordRows(await ctx.deps.control.admin({ action: "status", records: true }));
    if (values["records"] !== true) rows = rows.filter((r) => r.key.startsWith("rec/release"));
  }
  return { status, rows, wantRecords };
}

export const status: Command = {
  name: "status",
  summary: "Print the control function status; --records and --releases add detail.",
  options: { watch: { type: "boolean" }, records: { type: "boolean" }, releases: { type: "boolean" } },
  mode: "operator",
  mutates: false,
  run: async (ctx, values) => {
    let last = "";
    for (;;) {
      const { status: s, rows, wantRecords } = await once(ctx, values);
      const lines = [...statusLines(s), ...(wantRecords ? ["", ...recordLines(rows, ctx.deps.clock.now())] : [])];
      const text = lines.join("\n");
      if (text !== last) for (const l of lines) say(ctx, values, l);
      last = text;
      if (values["watch"] !== true || isJson(values)) {
        const json = wantRecords ? { status: s, records: rows } : s;
        return { exitCode: EXIT.ok, json };
      }
      await ctx.deps.clock.sleep(WATCH_EVERY_MS, ctx.signal);
    }
  },
};
