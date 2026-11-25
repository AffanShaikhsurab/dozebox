import { stubCommand } from "../command.ts";

export const snapshots = stubCommand("L3", {
  name: "snapshots",
  summary: "List, create or delete data volume snapshots.",
  mode: "operator",
  mutates: true,
});
