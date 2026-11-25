// The typed single-action reconciler (decide.ts) is what the control function's tick runs. The legacy-shaped modules
// (facts, model, start, steps, launch) are the legacy control's rules, moved without change of behaviour; the legacy
// control and the simulator call them through legacy/runner/control/core.mjs until the TypeScript simulator replaces it.
export {
  decideReconcile,
  REFUSED_FALLBACK_AFTER_MS,
  REPLACING_WINDOW_MS,
  SLEEP_FENCE_MS,
  type Action,
  type Desired,
  type DesiredOrigin,
  type Ec2State,
  type FallbackWhy,
  type Observed,
} from "./decide.ts";
export {
  isLive,
  isLiveState,
  parseStoppedAt,
  timeMs,
  type AsgFacts,
  type AsgInstanceFacts,
  type AsgStatusFacts,
  type InstanceRecord,
  type IntentFacts,
  type Iso,
  type PersistentFacts,
  type Snapshot,
  type SpotRequestFacts,
  type VolumeFacts,
} from "./facts.ts";
export {
  nextAfterSpotMiss,
  readLaunch,
  readLaunchError,
  type LaunchRead,
  type LaunchResult,
  type LaunchedInstance,
} from "./launch.ts";
export {
  answeredByServingBox,
  FALLBACK_REASON_MS,
  hasInterruptedIntent,
  INTENT_FRESH_MS,
  INTERRUPTED_RETRY_AFTER_MS,
  interruptionTime,
  isInterrupted,
  liveLaunchedMs,
  newestLaunchMs,
  pickPersistent,
  replacingNow,
  view,
  wakeCancelled,
  warningFenceFloor,
  SLEEP_FENCE_BLOCKS_MS,
  STALE_READ_MS,
  startInFlight,
  type View,
} from "./model.ts";
export { decideStart, type FallbackReason, type StartDecision } from "./start.ts";
export { decideSteps, WAKE_GRACE_MS, WAKE_LEAD_MS, type Step, type StepsDeps } from "./steps.ts";
