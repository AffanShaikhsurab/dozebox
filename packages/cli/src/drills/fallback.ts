// D2: `dozebox drill fallback`. A launch template version Spot cannot serve; a person's wake serves On-Demand; teardown restores the default.
import type { Drill } from "./types.ts";

export const fallbackDrill: Drill = {
  name: "fallback",
  estimateUsd: async () => {
    throw new Error("not implemented: D2 drill fallback");
  },
  steps: [],
  teardown: async () => {
    throw new Error("not implemented: D2 drill fallback");
  },
};
