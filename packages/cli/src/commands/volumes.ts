import { stubCommand } from "../command.ts";

export const volumes = stubCommand("L4", {
  name: "volumes",
  summary: "List or retire the box volumes; flags a box with no active volume.",
  mode: "operator",
  mutates: true,
});
