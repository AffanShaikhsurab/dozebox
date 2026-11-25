// Reading what the group's synchronous launch answers, and the step after a Spot miss. Ported without change of
// behaviour from the legacy control's `launch.mjs`.

const CAPACITY = "InsufficientInstanceCapacity";
const PRICE = "SpotMaxPriceTooLow";
const QUOTA = new Set([
  "MaxSpotInstanceCountExceeded",
  "VcpuLimitExceeded",
  "InstanceLimitExceeded",
  "InsufficientInstanceCapacityQuota",
]);

export type LaunchedInstance = {
  readonly id: string;
  readonly type?: string | null;
  readonly az?: string | null;
  readonly market?: string | null;
};
export type LaunchResult = {
  readonly instances?: ReadonlyArray<LaunchedInstance> | null;
  readonly errors?: ReadonlyArray<{ readonly code?: string | null }> | null;
};
export type LaunchRead =
  | { readonly outcome: "launched"; readonly instance: LaunchedInstance; readonly codes: string[] }
  | { readonly outcome: "capacity" | "price" | "quota" | "failed"; readonly codes: string[] };

export function readLaunch(result: LaunchResult | null | undefined): LaunchRead {
  const codes = [...new Set((result?.errors ?? []).map((e) => e.code).filter((c): c is string => Boolean(c)))];
  const instance = result?.instances?.[0];
  if (instance) return { outcome: "launched", instance, codes };
  if (codes.includes(CAPACITY)) return { outcome: "capacity", codes };
  if (codes.length > 0 && codes.every((c) => c === PRICE)) return { outcome: "price", codes };
  if (codes.some((c) => QUOTA.has(c))) return { outcome: "quota", codes };
  return { outcome: "failed", codes };
}

/**
 * What a thrown launch error means: `full` (the group holds its one instance), `in-progress` (same client token),
 * `busy` (another update is pending), `unavailable` (no synchronous launch), `error` (anything else).
 */
export function readLaunchError(error: unknown): "full" | "in-progress" | "busy" | "unavailable" | "error" {
  const e = (typeof error === "object" && error !== null ? error : {}) as {
    readonly name?: unknown;
    readonly message?: unknown;
  };
  const name = e.name ?? "";
  const message = String(e.message ?? "");
  if (name === "LaunchInstancesUnavailable") return "unavailable";
  if (name === "IdempotentCallInProgress") return "in-progress";
  if (name === "ResourceContention" || name === "ScalingActivityInProgress") return "busy";
  if (name === "ValidationError" && /exceeds the Maximum Size/i.test(message)) return "full";
  return "error";
}

/**
 * The step after a Spot miss: a person's wake takes On-Demand when the day still has room; an unattended wake waits
 * for Spot. A quota or unknown failure retries nothing.
 */
export function nextAfterSpotMiss(i: {
  readonly outcome: string;
  readonly origin: string;
  readonly onDemandAllowed: boolean;
}): "on-demand" | "wait" | "failed" {
  if (i.outcome !== "capacity" && i.outcome !== "price") return "failed";
  return i.origin === "user" && i.onDemandAllowed ? "on-demand" : "wait";
}
