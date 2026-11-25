// `dozebox-jail-exec` (bin, run by a payload user through sudo): start an agent command in the payload's jail as
// `<payload>-agent`. The payload is the one whose user is SUDO_UID; the jail settings come from the last good config.
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { lastGoodPath } from "../config/load.ts";
import { parseLastGood } from "../config/parse.ts";
import { readEnv } from "../env.ts";
import { messageOf } from "../errors.ts";
import { resolveJailExec } from "../jail/index.ts";
import { parsePasswd } from "../supervisor/users.ts";

async function main(): Promise<number> {
  const env = readEnv(process.env, process.pid);
  const cfg = parseLastGood(await readFile(lastGoodPath(env.stateDir), "utf8"), env);
  if (!cfg.ok) throw new Error(cfg.problem);
  const users = parsePasswd(await readFile("/etc/passwd", "utf8"));
  const caller = users.find((u) => String(u.uid) === process.env["SUDO_UID"]);
  const def = cfg.value.payloads.find((p) => p.user === caller?.name);
  if (!def) throw new Error("dozebox-jail-exec: run it as a payload user through sudo");
  const agent = users.find((u) => u.name === `${def.name}-agent`);
  if (!agent) throw new Error(`dozebox-jail-exec: no user ${def.name}-agent`);
  const j = cfg.value.box.jail;
  const argv = await resolveJailExec(
    {
      realpath,
      config: {
        enabled: j.enabled && j.egress !== "off",
        egress: j.egress === "allowlist" ? "allowlist" : "imds-only",
        allowHosts: j.allowHosts,
      },
      payload: def.name,
      agentUid: agent.uid,
      decoy: cfg.value.box.tripwire.enabled,
    },
    process.argv.slice(2),
  );
  const [cmd, ...args] = argv;
  if (cmd === undefined) throw new Error("dozebox-jail-exec: nothing to run");
  const child = spawn(cmd, args, { stdio: "inherit" });
  return new Promise((resolve) => child.once("close", (code) => resolve(code ?? 1)));
}

try {
  process.exitCode = await main();
} catch (e) {
  process.stderr.write(`${messageOf(e)}\n`);
  process.exitCode = 2;
}
