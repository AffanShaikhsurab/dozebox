// `dozeboxd`, the box agent (bin). Run by `dozeboxd.service` (Type=notify, NotifyAccess=all, WatchdogSec=60).
import { makeDeps } from "./deps.ts";
import { readEnv } from "./env.ts";
import { runAgent } from "./run.ts";

async function main(): Promise<void> {
  const deps = await makeDeps(readEnv(process.env, process.pid));
  try {
    await runAgent(deps, process);
  } catch (e) {
    deps.log.log("error", "dozeboxd did not start", { error: e });
    process.exit(1);
  }
}

await main();
