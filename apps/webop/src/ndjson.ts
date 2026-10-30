import type { Readable, Writable } from "node:stream";

export function writeLine(sock: Writable, msg: unknown): void {
  if (sock.destroyed || !sock.writable) return;
  sock.write(JSON.stringify(msg) + "\n");
}

export function readLines(sock: Readable, onMsg: (m: unknown) => void): void {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onMsg(msg);
    }
  });
}
