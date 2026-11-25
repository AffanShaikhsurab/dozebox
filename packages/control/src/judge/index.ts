export { checkBudgetFreeze, type FreezeDeps } from "../caps/freeze.ts";
export {
  makeRestoreTest,
  type RestoreTest,
  type RestoreTestDeps,
  type RestoreTestResult,
  type RestoreTestState,
} from "../restore-test/run.ts";
export {
  makeOutsideJudge,
  NO_MARKS,
  SILENT_AFTER_MS,
  WAKE_UNRESOLVED_MS,
  type JudgeDeps,
  type JudgeMarks,
  type JudgeVerdict,
  type OutsideJudge,
} from "./outside.ts";
