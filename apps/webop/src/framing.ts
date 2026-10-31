// Chrome Native Messaging framing: 4-byte little-endian uint32 length + UTF-8 JSON.
export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

export class FrameDecoder {
  #buf: Buffer = Buffer.alloc(0);

  // Returns every complete message in the buffered input. Frames with malformed JSON
  // are dropped so callers never throw.
  push(chunk: Buffer): unknown[] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out: unknown[] = [];
    while (this.#buf.length >= 4) {
      const len = this.#buf.readUInt32LE(0);
      if (this.#buf.length < 4 + len) break;
      const body = this.#buf.subarray(4, 4 + len);
      this.#buf = this.#buf.subarray(4 + len);
      try {
        out.push(JSON.parse(body.toString("utf8")));
      } catch {
        // malformed frame: drop
      }
    }
    return out;
  }
}
