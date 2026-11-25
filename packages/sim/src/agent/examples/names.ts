// Payload model names (S3). This directory is skipped by `scripts/check-words.ts`, which keeps payload names out of
// the runner: the simulator may model a named payload, the runner may not know one.
export const CI_WAITS = "nightshift-like" as const;

export type PayloadName = "generic" | typeof CI_WAITS;
