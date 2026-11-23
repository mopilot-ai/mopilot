// Fragmented binary input without repeated concatenation: headers peek cheaply and complete bodies copy once.
class ByteQueue {
  constructor() {
    this.parts = [];
    this.head = 0;
    this.offset = 0;
    this.length = 0;
  }
  push(chunk) {
    if (!chunk.length) return;
    this.parts.push(chunk);
    this.length += chunk.length;
  }
  peek(size) {
    if (size > this.length) return null;
    if (!size) return Buffer.alloc(0);
    const first = this.parts[this.head];
    if (first.length - this.offset >= size) return first.subarray(this.offset, this.offset + size);
    const out = Buffer.allocUnsafe(size);
    let at = 0;
    for (let index = this.head; at < size; index++) {
      const part = this.parts[index];
      const from = index === this.head ? this.offset : 0;
      const count = Math.min(part.length - from, size - at);
      part.copy(out, at, from, from + count);
      at += count;
    }
    return out;
  }
  take(size) {
    const out = this.peek(size);
    if (out === null) return null;
    this.discard(size);
    return out;
  }
  discard(size) {
    this.length -= size;
    while (size) {
      const count = Math.min(size, this.parts[this.head].length - this.offset);
      size -= count;
      this.offset += count;
      if (this.offset === this.parts[this.head].length) {
        this.head++;
        this.offset = 0;
      }
    }
    if (this.head === this.parts.length) {
      this.parts = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.parts.length) {
      this.parts = this.parts.slice(this.head);
      this.head = 0;
    }
  }
}
module.exports = { ByteQueue };
