export * from "./common.ts";
export * from "./hello.ts";
export * from "./holds.ts";
export * from "./beats.ts";
export * from "./wakes.ts";
export * from "./presence.ts";
export * from "./attention.ts";
export * from "./status.ts";
export * from "./health.ts";
export * from "./sleep.ts";
export * from "./events.ts";
export * from "./normalize.ts";
export { ProtocolDecodeError, describeProblems } from "../decode.ts";

/** The protocol major and minor this package describes. */
export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
