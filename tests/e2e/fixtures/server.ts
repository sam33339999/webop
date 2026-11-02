import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

/** A loopback port nothing listens on (Chrome blocks well-known ports such as 1 as "unsafe", so pick a free one). */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("probe has no port");
  return address.port;
}

export async function startServer(): Promise<{ port: number; server: Server; close(): Promise<void> }> {
  const refusedPort = await closedPort();
  const server = createServer(async (req, res) => {
    const parsed = new URL(req.url ?? "/", "http://x");
    const path = parsed.pathname;
    // Server-side redirect: /redirect302?to=<absolute url>.
    if (path === "/redirect302") {
      res.writeHead(302, { location: parsed.searchParams.get("to") ?? "/" }).end();
      return;
    }
    // A page whose response is held back: /slow?ms=<delay> (a navigation to it stays uncommitted meanwhile).
    if (path === "/slow") {
      const ms = Math.min(Number(parsed.searchParams.get("ms") ?? "3000") || 0, 20_000);
      setTimeout(() => {
        if (!res.writableEnded) res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>slow</title><p>slow</p>");
      }, ms);
      return;
    }
    const status = /^\/status\/(\d{3})$/.exec(path);
    if (status) {
      res.writeHead(Number(status[1]), { "content-type": "text/plain" }).end(`status ${status[1]}`);
      return;
    }
    const file = normalize(join(dir, path === "/" ? "button.html" : path));
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const ext = file.slice(file.lastIndexOf("."));
      let body: Buffer | string = await readFile(file);
      // Pages that need a connection-refused request get the closed port filled in.
      if (ext === ".html") body = body.toString("utf8").replaceAll("__REFUSED_PORT__", String(refusedPort));
      res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  return {
    port: address.port,
    server,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
