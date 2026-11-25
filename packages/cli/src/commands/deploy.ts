import { stubCommand } from "../command.ts";

export const deploy = stubCommand("L1", {
  name: "deploy",
  summary: "Run terraform init and apply in the stack directory.",
  mode: "operator",
  mutates: true,
});
