// Shared fakes for the supervisor tests.
import type { PayloadDefinition } from "@dozebox/protocol/payload";
import { makeFakeClock, makeFakeFs } from "@dozebox/testkit/fakes";
import { makeNodeFiles, type FsPromises } from "../src/adapters/files.ts";
import { makeJsonLogger } from "../src/adapters/log.ts";

export type Install = NonNullable<PayloadDefinition["install"]>;

export const def = (over: Record<string, unknown> = {}): PayloadDefinition =>
  ({
    schema: 1,
    name: "web",
    user: "web",
    protocol: "none",
    start: { command: ["/usr/bin/web"] },
    ...over,
  }) as PayloadDefinition;
export const install = (over: Partial<Install> = {}): Install => ({
  command: ["./setup.sh"],
  when: "on-change",
  timeoutSeconds: 60,
  ...over,
});

export function world(files: Record<string, string> = {}) {
  const clock = makeFakeClock();
  const fake = makeFakeFs(files);
  const store = makeNodeFiles(fake.fs.promises as unknown as FsPromises, 1);
  return { clock, fake, files: store, log: makeJsonLogger(() => {}, clock.now) };
}
export const marker = (w: ReturnType<typeof world>) => w.fake.snapshot()["/data/dozebox/payloads/web/install.json"];
export const sig = (): AbortSignal => new AbortController().signal;
