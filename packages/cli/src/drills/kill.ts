// D3: `dozebox drill kill`. Cap alarm threshold to 0 for 10 min: deny attached, instance stopped, group 0, page; then unfreeze.
import type { Drill } from "./types.ts";

export const killDrill: Drill = {
  name: "kill",
  estimateUsd: async () => {
    throw new Error("not implemented: D3 drill kill");
  },
  steps: [],
  teardown: async () => {
    throw new Error("not implemented: D3 drill kill");
  },
};
