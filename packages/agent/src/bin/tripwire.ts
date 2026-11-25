// `dozebox-tripwire` (bin). As the decoy profile's credential_process: tell the tripwire socket which context used it,
// return no credentials, exit 1. With `--report` (the socket's per-connection service): append the hit.
import { appendFile } from "node:fs/promises";
import { connect } from "node:net";
import { text } from "node:stream/consumers";
import { hitLine, TRIPWIRE_HITS, TRIPWIRE_PORT } from "../jail/index.ts";

if (process.argv[2] === "--report") {
  await appendFile(TRIPWIRE_HITS, hitLine(await text(process.stdin), Date.now()));
} else {
  const context = (process.env["DOZEBOX_CONTEXT"] ?? "unknown").slice(0, 64);
  await new Promise<void>((resolve) => {
    const s = connect(TRIPWIRE_PORT, "127.0.0.1", () => s.end(`decoy-key ${context}\n`));
    s.once("close", () => resolve());
    s.once("error", () => resolve());
    s.setTimeout(2_000, () => s.destroy());
  });
  process.exitCode = 1;
}
