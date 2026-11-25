// D3: `dozebox drill front-door`. `/v1/status` and `/v1/wake` through CloudFront with the token; a wrong token answers
// 401. It cannot run in the test account: its user has no CloudFront or WAF permissions, so `front_door = true` cannot
// be applied. The drill exists so the report says so instead of silently skipping it.
import type { Drill } from "./types.ts";

export const frontDoorDrill: Drill = {
  name: "front-door",
  blocked: "the test account's user has no CloudFront or WAF permissions; front_door=true cannot be applied",
  estimateUsd: async () => 0,
  steps: [],
  teardown: async () => {},
};
