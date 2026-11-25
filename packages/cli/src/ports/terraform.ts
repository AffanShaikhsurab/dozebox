// Terraform in the stack directory, and the operator's files (`.dozebox/stack.json`, `main.tf`). Fakes: testkit.

export type TerraformOutputs = Readonly<Record<string, { readonly value: unknown; readonly sensitive: boolean }>>;

export interface Terraform {
  readonly init: (dir: string, signal: AbortSignal) => Promise<void>;
  /** `plan` with `-detailed-exitcode`: true when there are changes. */
  readonly plan: (dir: string, vars: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<boolean>;
  readonly apply: (dir: string, vars: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<void>;
  readonly destroy: (dir: string, signal: AbortSignal) => Promise<void>;
  readonly output: (dir: string) => Promise<TerraformOutputs>;
}

export interface CliFiles {
  readonly readText: (path: string) => Promise<string | null>;
  readonly writeText: (path: string, text: string) => Promise<void>;
}
