export { makeFakeClock, type FakeClock } from "./clock.ts";
export { makeFakeFs, type FakeFs } from "./fs.ts";
export {
  makeFakeExec,
  UnscriptedCommandError,
  type ExecCall,
  type ExecOptions,
  type ExecOutcome,
  type ExecResult,
  type ExecScript,
  type FakeExec,
} from "./exec.ts";
export {
  IMDS_TOKEN_HEADER,
  IMDS_TTL_HEADER,
  startFakeImds,
  type FakeImds,
  type FakeImdsOptions,
  type ImdsIdentity,
  type ImdsRequest,
  type SpotAction,
} from "./imds.ts";
