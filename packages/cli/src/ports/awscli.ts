// The AWS CLI as the drills use it: SSM Run Command on the box, FIS, launch template versions, alarms, the tagging
// API. Drills are a test tool that runs where `aws` is installed (B1, the aws-drills workflow), so they call the CLI
// instead of adding an SDK client per service. Fake: testkit `makeFakeAwsCli`.

export interface AwsCli {
  /**
   * Runs `aws <args> --output json` and returns the parsed stdout (null for empty output). A non-zero exit throws
   * DozeboxCliError `aws` with the tail of stderr.
   */
  readonly json: (args: ReadonlyArray<string>, signal?: AbortSignal) => Promise<unknown>;
}
