import { stubCommand } from "../command.ts";

export const bootstrap = stubCommand("L2", {
  name: "bootstrap",
  summary: "Create the state bucket and deploy principal policies; activate the cost tag.",
  mode: "operator",
  mutates: true,
});
