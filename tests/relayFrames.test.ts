// relay/src/frames.mjs: what a client may send is shape-checked and size-capped; the relay never needs to open a box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BOX_BYTES,
  MAX_MESSAGE_BYTES,
  encode,
  encodeFrame,
  isPairId,
  parseAck,
  parseFrame,
  parseMessage,
} from '../relay/src/frames.mjs';

const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64');
const frame = (over: object = {}) => ({ t: 'frame', pair: 'p_abcdefgh12', dir: 'p2m', ctr: 3, nonce: b64(24), box: b64(100), ...over });

test('pair ids are opaque but bounded', () => {
  assert.ok(isPairId('p_9f3a-B_cdefgh'));
  for (const bad of ['', 'p_short', 'q_abcdefgh12', `p_${'a'.repeat(65)}`, 'p_has space!!', 7, null, undefined])
    assert.equal(isPairId(bad), false);
});

test('parseMessage accepts a JSON object with a type, nothing else', () => {
  assert.deepEqual(parseMessage('{"t":"x","a":1}'), { t: 'x', a: 1 });
  for (const bad of ['', '{', '[]', '"s"', 'null', '{"t":1}', '{"a":1}']) assert.equal(parseMessage(bad), null);
  assert.equal(parseMessage(`{"t":"x","p":"${'a'.repeat(MAX_MESSAGE_BYTES)}"}`), null);
});

test('a well-formed frame parses to bytes; a 256 KB box fits and one byte more does not', () => {
  const f = parseFrame(frame())!;
  assert.equal(f.pairId, 'p_abcdefgh12');
  assert.equal(f.dir, 'p2m');
  assert.equal(f.ctr, 3);
  assert.equal(f.box.length, 100);
  assert.equal(f.nonce.length, 24);
  assert.ok(parseFrame(frame({ box: b64(MAX_BOX_BYTES) })));
  assert.equal(parseFrame(frame({ box: b64(MAX_BOX_BYTES + 1) })), null);
  assert.ok(parseFrame(frame({ dir: 'm2p', ctr: 0 })));
});

test('every malformed field is refused', () => {
  const bad: object[] = [
    { pair: 'nope' },
    { dir: 'sideways' },
    { ctr: -1 },
    { ctr: 1.5 },
    { ctr: '3' },
    { ctr: Number.MAX_SAFE_INTEGER + 2 },
    { nonce: '' },
    { nonce: 5 },
    { nonce: '***' },
    { nonce: b64(65) },
    { box: '' },
    { box: 'a'.repeat(400_000) },
    { box: '!!' },
    { box: undefined },
  ];
  for (const over of bad) assert.equal(parseFrame(frame(over)), null, JSON.stringify(over).slice(0, 60));
});

test('encoding round-trips the exact bytes', () => {
  const f = parseFrame(frame())!;
  const out = JSON.parse(encodeFrame(f.pairId, f.dir, f.ctr, f.nonce, f.box));
  assert.deepEqual(out, { t: 'frame', pair: 'p_abcdefgh12', dir: 'p2m', ctr: 3, nonce: b64(24), box: b64(100) });
  assert.equal(encode({ a: 1 }), '{"a":1}');
});

test('a receipt names a pair, a direction and a counted frame; counter 0 (the pairing hello) is never acked', () => {
  assert.deepEqual(parseAck({ t: 'ack', pair: 'p_abcdefgh12', dir: 'p2m', ctr: 3 }), { pairId: 'p_abcdefgh12', dir: 'p2m', ctr: 3 });
  for (const bad of [{ ctr: 0 }, { ctr: -1 }, { ctr: 1.5 }, { dir: 'up' }, { pair: 'x' }])
    assert.equal(parseAck({ t: 'ack', pair: 'p_abcdefgh12', dir: 'p2m', ctr: 3, ...bad }), null);
});
