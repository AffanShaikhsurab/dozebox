// The marker payload: serves /health and proves a restore by a nonce file. Node built-ins only.
//   node server.mjs                 start (writes $MARKER_NONCE to $MARKER_DIR/nonce once, then serves)
//   node server.mjs verify <nonce>  exit 0 when the nonce file holds <nonce>, else 1 (the verifyRestore hook)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const dir = process.env.MARKER_DIR ?? "/data/payloads/marker";
const nonceFile = join(dir, "nonce");

if (process.argv[2] === "verify") {
  const want = (process.argv[3] ?? "").trim();
  const have = existsSync(nonceFile) ? readFileSync(nonceFile, "utf8").trim() : null;
  process.exit(want !== "" && have === want ? 0 : 1);
}

const nonce = process.env.MARKER_NONCE;
if (nonce && !existsSync(nonceFile)) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(nonceFile, `${nonce}\n`, { flag: "wx" });
}

const port = Number(process.env.MARKER_PORT ?? 8080);
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  } else {
    res.writeHead(404).end();
  }
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`marker listening on 127.0.0.1:${port}\n`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
