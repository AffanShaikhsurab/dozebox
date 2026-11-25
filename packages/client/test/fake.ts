import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Seen = {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: unknown;
};
export type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;

export type Fake = { readonly socketPath: string; readonly seen: Seen[] };

/** An in-process agent on a temp unix socket. Closed by `t.after`. */
export async function startFake(
  t: { after: (fn: () => Promise<void> | void) => void },
  handler: Handler,
): Promise<Fake> {
  const dir = mkdtempSync(join(tmpdir(), "dz-client-"));
  const socketPath = join(dir, "p.sock");
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return { socketPath, seen };
}

export function reply(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

export const errorBody = (code: string, retryable: boolean, message = "boom") => ({
  error: { code, message, retryable },
});

export const noDelay = async (): Promise<void> => undefined;
