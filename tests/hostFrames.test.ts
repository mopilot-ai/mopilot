// The Host wire's frame codec (shared/host/frames.mjs): control lines, binary frames, and what a malformed or truncated stream does (B1, B2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createDecoder, encodeControl, encodeBinary, FrameError, MAX_FRAME } = require('../shared/host/frames.mjs');

test('a control message round-trips, in pieces and several to a chunk', () => {
  const d = createDecoder();
  const bytes = Buffer.concat([encodeControl({ id: 1, method: 'a' }), encodeControl({ id: 2 })]);
  assert.deepEqual(d.push(bytes.subarray(0, 5)), []);
  assert.equal(d.pending(), 5);
  const out = d.push(bytes.subarray(5));
  assert.deepEqual(
    out.map((f: any) => f.message),
    [{ id: 1, method: 'a' }, { id: 2 }],
  );
  assert.equal(d.pending(), 0);
  assert.deepEqual(d.push('{"id":3}\n')[0].message, { id: 3 });
});

test('a binary frame carries meta and bytes, mixed with control lines, byte by byte', () => {
  const d = createDecoder();
  const data = Buffer.from([0, 1, 2, 10, 255]);
  const bytes = Buffer.concat([encodeControl({ id: 1 }), encodeBinary({ shot: 7 }, data), encodeControl({ id: 2 })]);
  const out: any[] = [];
  for (const b of bytes) out.push(...d.push(Buffer.from([b])));
  assert.equal(out.length, 3);
  assert.deepEqual(out[1].meta, { shot: 7 });
  assert.deepEqual([...out[1].data], [...data]);
  assert.equal(out[2].message.id, 2);
});

test('B2: a truncated frame stays pending, never half-delivered', () => {
  const d = createDecoder();
  const frame = encodeBinary({ a: 1 }, Buffer.alloc(100));
  assert.deepEqual(d.push(frame.subarray(0, 50)), []);
  assert.equal(d.pending(), 50);
  assert.deepEqual(d.push(frame.subarray(0, 0)), []);
  const short = createDecoder();
  assert.deepEqual(short.push(Buffer.from([0, 0, 0])), []);
  assert.equal(short.pending(), 3);
});

test('B1: not JSON, not an object, and bad binary headers are FrameErrors', () => {
  const code = (bytes: Buffer | string) => {
    try {
      createDecoder().push(bytes);
    } catch (e: any) {
      assert.ok(e instanceof FrameError);
      return e.code;
    }
    return null;
  };
  assert.equal(code('nope\n'), 'not-json');
  assert.equal(code('[1]\n'), 'not-object');
  assert.equal(code('null\n'), 'not-object');
  assert.equal(code('5\n'), 'not-object');
  const head = (total: number, meta: number) => {
    const b = Buffer.alloc(9);
    b.writeUInt32BE(total, 1);
    b.writeUInt32BE(meta, 5);
    return b;
  };
  assert.equal(code(head(2, 0)), 'bad-binary');
  assert.equal(code(head(10, 9)), 'bad-binary');
  assert.equal(code(Buffer.concat([head(5, 1), Buffer.from('x')])), 'bad-binary');
  assert.equal(code(Buffer.concat([head(5, 1), Buffer.from('[')])), 'bad-binary');
  assert.equal(code(Buffer.concat([head(5, 1), Buffer.from('1')])), 'not-object');
});

test('B2: a frame past the limit is refused, on the wire and when encoding', () => {
  const d = createDecoder({ maxFrame: 16 });
  assert.throws(
    () => d.push('x'.repeat(17)),
    (e: any) => e.code === 'too-large',
  );
  assert.throws(
    () => createDecoder({ maxFrame: 4 }).push('{"a":1}\n'),
    (e: any) => e.code === 'too-large',
  );
  const head = Buffer.alloc(9);
  head.writeUInt32BE(1000, 1);
  assert.throws(
    () => createDecoder({ maxFrame: 16 }).push(head),
    (e: any) => e.code === 'too-large',
  );
  assert.throws(
    () => encodeControl({ s: 'x'.repeat(MAX_FRAME) }),
    (e: any) => e.code === 'too-large',
  );
  assert.throws(
    () => encodeBinary({}, Buffer.alloc(MAX_FRAME)),
    (e: any) => e.code === 'too-large',
  );
});

test('a large frame in small pieces decodes once, and an empty piece changes nothing', () => {
  const d = createDecoder();
  const data = Buffer.alloc(300_000, 7);
  const bytes = Buffer.concat([encodeBinary({ big: true }, data), encodeControl({ after: 1 })]);
  const out: any[] = [];
  d.push(new Uint8Array(0));
  for (let i = 0; i < bytes.length; i += 1000) out.push(...d.push(new Uint8Array(bytes.subarray(i, i + 1000))));
  assert.equal(out.length, 2);
  assert.equal(out[0].data.length, 300_000);
  assert.equal(d.pending(), 0);
  // a long line in pieces is held until its newline, and refused past the limit
  const line = createDecoder({ maxFrame: 64 });
  assert.deepEqual(line.push('{"a":"'), []);
  assert.deepEqual(line.push('x'.repeat(20)), []);
  assert.equal(line.pending(), 26);
  assert.throws(
    () => line.push('y'.repeat(60)),
    (e: any) => e.code === 'too-large',
  );
});

test('a line cut off right after a binary frame in the same chunk is held, and refused past the limit', () => {
  const d = createDecoder({ maxFrame: 64 });
  const out = d.push(Buffer.concat([encodeBinary({ a: 1 }, Buffer.from('z')), Buffer.from('{"b"')]));
  assert.equal(out.length, 1);
  assert.equal(d.pending(), 4);
  assert.deepEqual(d.push(':2}\n')[0].message, { b: 2 });
  assert.throws(
    () => d.push(Buffer.concat([encodeBinary({ a: 1 }, Buffer.from('z')), Buffer.from(`{"${'k'.repeat(80)}`)])),
    (e: any) => e.code === 'too-large',
  );
});
