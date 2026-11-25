// `dozebox-boot` (bin), run by `dozebox-boot.service` before dozeboxd: attach and mount the data volume (run.ts).
import { makeDeps } from "../deps.ts";
import { readEnv } from "../env.ts";
import { runBoot } from "./run.ts";

const deps = await makeDeps(readEnv(process.env, process.pid));
process.exitCode = await runBoot(deps, new AbortController().signal);
