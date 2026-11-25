// D2: `dozebox drill spot`. FIS `aws:ec2:send-spot-instance-interruptions` with a hold live; stop condition on the cap alarm.
import type { Drill } from "./types.ts";

export const spotDrill: Drill = {
  name: "spot",
  estimateUsd: async () => {
    throw new Error("not implemented: D2 drill spot");
  },
  steps: [],
  teardown: async () => {
    throw new Error("not implemented: D2 drill spot");
  },
};
