import { stubCommand } from "../command.ts";

export const destroy = stubCommand("L3", {
  name: "destroy",
  summary: "Snapshot every tagged volume, then terraform destroy.",
  mode: "operator",
  mutates: true,
});
