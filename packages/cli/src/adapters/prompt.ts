// Questions to the person at the terminal. Nothing here reads argv: a secret comes from the TTY or from stdin.
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { DozeboxCliError } from "../command.ts";
import type { Prompt } from "../ports/prompt.ts";

export type PromptInput = Readable & { readonly isTTY?: boolean; readonly setRawMode?: (mode: boolean) => unknown };

export type PromptDeps = { readonly stdin: PromptInput; readonly stderr: (text: string) => void };

export function makePrompt(deps: PromptDeps): Prompt {
  const { stdin, stderr } = deps;

  async function confirm(question: string): Promise<boolean> {
    if (stdin.isTTY !== true) return false;
    stderr(`${question} [y/N] `);
    const rl = createInterface({ input: stdin });
    const answer = await new Promise<string>((resolve) => {
      rl.once("line", resolve);
      rl.once("close", () => resolve(""));
    });
    rl.close();
    return /^(y|yes)$/i.test(answer.trim());
  }

  function readHidden(label: string): Promise<string> {
    stderr(`${label}: `);
    return new Promise((resolve, reject) => {
      let value = "";
      const finish = (end: () => void): void => {
        stdin.off("data", onData);
        stdin.setRawMode?.(false);
        stdin.pause();
        stderr("\n");
        end();
      };
      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") return finish(() => resolve(value));
          if (ch === "\u0003")
            return finish(() => reject(new DozeboxCliError("refused", "Cancelled; nothing changed.")));
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.setEncoding("utf8");
      stdin.setRawMode?.(true);
      stdin.on("data", onData);
      stdin.resume();
    });
  }

  async function readAll(): Promise<string> {
    stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of stdin) text += String(chunk);
    return text.replace(/\r?\n$/, "");
  }

  return {
    confirm,
    secret: async (label) => {
      const value = stdin.isTTY === true ? await readHidden(label) : await readAll();
      if (value === "") throw new DozeboxCliError("usage", "no value on stdin");
      return value;
    },
  };
}
