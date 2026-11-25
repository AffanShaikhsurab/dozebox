// D3: `dozebox drill front-door`. `/v1/status` and `/v1/wake` through CloudFront with the token; a wrong token answers 401.
import type { Drill } from "./types.ts";

export const frontDoorDrill: Drill = {
  name: "front-door",
  estimateUsd: async () => {
    throw new Error("not implemented: D3 drill front-door");
  },
  steps: [],
  teardown: async () => {
    throw new Error("not implemented: D3 drill front-door");
  },
};
