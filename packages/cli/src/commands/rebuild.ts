import { stubCommand } from "../command.ts";

export const rebuild = stubCommand("L4", {
  name: "rebuild",
  summary: "Replace the instance and keep the volume.",
  mode: "operator",
  mutates: true,
});
