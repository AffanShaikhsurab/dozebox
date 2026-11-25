// The operator's local tools, for `doctor`. Fake: testkit `makeFakeTools`.

export type ToolName = "aws" | "terraform" | "node";

export interface Tools {
  /** The version the tool prints (`terraform version -json`, `aws --version`), or null when it is not installed. */
  readonly version: (tool: ToolName) => Promise<string | null>;
}
