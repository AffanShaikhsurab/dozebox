// The stack a command acts on: `--stack <dir>` (default `./.dozebox`), checked against `--box`.
import { DozeboxCliError, type CommandContext } from "./command.ts";
import { stringOpt, type Values } from "./output.ts";
import { readStack, type StackContext } from "./stack.ts";

export const DEFAULT_STACK_DIR = "./.dozebox";

export const stackDirOf = (values: Values): string => stringOpt(values, "stack") ?? DEFAULT_STACK_DIR;

export async function stackOf(
  ctx: CommandContext,
  values: Values,
  opts: { readonly refresh: boolean } = { refresh: false },
): Promise<StackContext> {
  const stack = await readStack(ctx.deps, stackDirOf(values), opts);
  const box = stringOpt(values, "box");
  if (box !== undefined && box !== stack.boxId) {
    throw new DozeboxCliError(
      "usage",
      `--box ${box} does not match the stack in ${stack.stackDir} (box ${stack.boxId}); pass --stack for that box`,
    );
  }
  return stack;
}
