// Fragmented browser pipes and WebSocket frames must not repeatedly concatenate their accumulated prefix.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { FrameDecoder, encodeFrame } = require('../electron/capabilities/browser/iabBackend/wire.cjs');
const { FrameParser } = require('../electron/capabilities/browser/wsServer.cjs');

test('browser pipe and masked WebSocket payloads accumulate linearly across thousands of fragments', () => {
  const record = { text: 'x'.repeat(1024 * 1024) };
  const body = Buffer.from(JSON.stringify(record));
  const ws = Buffer.alloc(14 + body.length);
  ws[0] = 0x81;
  ws[1] = 0xff;
  ws.writeBigUInt64BE(BigInt(body.length), 2);
  ws.set([1, 2, 3, 4], 10);
  for (let at = 0; at < body.length; at++) ws[14 + at] = body[at] ^ ws[10 + (at & 3)];
  for (const [decoder, wire, expected] of [
    [new FrameDecoder(), encodeFrame(record), record],
    [new FrameParser(), ws, body],
  ] as const) {
    let copied = 0;
    const concat = Buffer.concat;
    const spy = mock.method(Buffer, 'concat', (parts: readonly Uint8Array[], length?: number) => {
      copied += parts.reduce((sum, part) => sum + part.length, 0);
      return concat(parts, length);
    });
    const out: any[] = [];
    try {
      for (let at = 0; at < wire.length; at += 1024) out.push(...decoder.push(wire.subarray(at, at + 1024)));
    } finally {
      spy.mock.restore();
    }
    assert.equal(out.length, 1);
    assert.deepEqual(Buffer.isBuffer(expected) ? out[0].payload : out[0], expected);
    assert.ok(copied <= wire.length * 2, `${copied} bytes copied for ${wire.length} bytes of input`);
  }
});
