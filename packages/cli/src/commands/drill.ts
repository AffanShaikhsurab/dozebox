import { stubCommand } from "../command.ts";

export const drill = stubCommand("D1", {
  name: "drill",
  summary: "Run a real-AWS drill: smoke, spot, fallback, kill, front-door, restore.",
  mode: "operator",
  mutates: true,
});
