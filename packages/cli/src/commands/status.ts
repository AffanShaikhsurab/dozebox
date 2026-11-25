import { stubCommand } from "../command.ts";

export const status = stubCommand("L1", {
  name: "status",
  summary: "Print the control function status; --records and --releases add detail.",
  mode: "both",
  mutates: false,
});
