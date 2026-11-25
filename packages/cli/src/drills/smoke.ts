// D1: `dozebox drill smoke`. Part 10 §10.1.2 steps 1 to 11 and 13 (12, the control upgrade, is skippable).
import type { Drill } from "./types.ts";

export const smokeDrill: Drill = {
  name: "smoke",
  estimateUsd: async () => {
    throw new Error("not implemented: D1 drill smoke");
  },
  steps: [],
  teardown: async () => {
    throw new Error("not implemented: D1 drill smoke");
  },
};
