// A8: the payload jail (part 8 §8.4, §8.5): bubblewrap profile and `dozebox jail exec`, AppArmor profile, per-uid
// nftables egress (`imds-only` or `allowlist`), and the tripwire (decoy profile, socket, report).
export { BWRAP, bwrapFlags, DECOY_CONFIG, ENV_ARGS_FD, jailArgv, type JailRun } from "./bwrap.ts";
export {
  ENV_FILE_MAX_BYTES,
  ENV_FILE_MAX_RECORDS,
  envArgsContent,
  JAIL_EXEC_BIN,
  parseEnvFile,
  parseJailExecArgs,
  payloadPath,
  PAYLOAD_DATA_ROOT,
  resolveJailExec,
  type JailEnvEntry,
  type JailExecArgs,
  type JailExecDeps,
  type JailExecPlan,
} from "./exec.ts";
export { takeEnvFile } from "./envFile.ts";
export {
  applyEgress,
  EGRESS_REFRESH_MS,
  egressLoop,
  NFT_FILE,
  NFT_TABLE,
  renderNftRules,
  resolveAllowHosts,
} from "./egress.ts";
export { APPARMOR_PROFILE, jailReadiness, renderAppArmorProfile, type JailReadiness } from "./ready.ts";
export {
  hitLine,
  makeTripwire,
  renderDecoyConfig,
  TRIPWIRE_HITS,
  TRIPWIRE_PORT,
  TRIPWIRE_UNITS,
  tripwireAlert,
  tripwireKey,
  type Tripwire,
  type TripwireHit,
} from "./tripwire.ts";
export type { EgressMode, JailConfig } from "./types.ts";
