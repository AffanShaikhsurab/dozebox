import { stubCommand } from "../command.ts";

export const restore = stubCommand("L3", {
  name: "restore",
  summary: "Restore the data volume from a snapshot.",
  mode: "operator",
  mutates: true,
});
