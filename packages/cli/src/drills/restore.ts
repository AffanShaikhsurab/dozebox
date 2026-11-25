// D3: `dozebox drill restore`. The weekly restore test, on demand.
import type { Drill } from "./types.ts";

export const restoreDrill: Drill = {
  name: "restore",
  estimateUsd: async () => {
    throw new Error("not implemented: D3 drill restore");
  },
  steps: [],
  teardown: async () => {
    throw new Error("not implemented: D3 drill restore");
  },
};
