'use strict';
// Random-access byte sources. FileSource reads ranges from disk; BufferSource wraps bytes
// that were read whole (remote or virtual workspaces).
const fs = require('fs');

class FileSource {
  static async open(p) { const fh = await fs.promises.open(p, 'r'); const st = await fh.stat(); return new FileSource(fh, st.size); }
  constructor(fh, size) { this.fh = fh; this.size = size; }
  async read(offset, length) {
    offset = Math.max(0, offset);
    length = Math.max(0, Math.min(length, this.size - offset));
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.fh.read(buf, done, length - done, offset + done);
      if (!bytesRead) break;
      done += bytesRead;
    }
    return done === length ? buf : buf.subarray(0, done);
  }
  async close() { try { await this.fh.close(); } catch { /* already closed */ } }
}

class BufferSource {
  constructor(bytes) { this.buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.size = this.buf.length; }
  async read(offset, length) { offset = Math.max(0, offset); return this.buf.subarray(offset, Math.min(this.size, offset + length)); }
  async close() {}
}

module.exports = { FileSource, BufferSource };
