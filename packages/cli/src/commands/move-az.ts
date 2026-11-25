import { stubCommand } from "../command.ts";

export const moveAz = stubCommand("L4", {
  name: "move-az",
  summary: "Move the data volume to another availability zone.",
  mode: "operator",
  mutates: true,
});
