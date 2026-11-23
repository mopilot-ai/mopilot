// The ack wire shared by the Mac and the phone (shared/remote/ack.mjs) against the relay's parser (relay/src/frames.mjs): what a peer sends is what the relay accepts, and a peer acks only final outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACK_TYPE, ReceiptAcker, encodeAck, incomingDir, relayAcks } from '../shared/remote/ack.mjs';
import { parseAck, parseMessage } from '../relay/src/frames.mjs';

const frame = { pair: 'p_abcdefgh12', dir: 'm2p', ctr: 4 };

test('an encoded ack round-trips through the relay parser; the relay refuses what a peer must never send', () => {
  const wire = JSON.stringify(encodeAck({ ...frame, nonce: 'x', box: 'y' } as any));
  assert.deepEqual(parseAck(parseMessage(wire)), { pairId: frame.pair, dir: 'm2p', ctr: 4 });
  assert.equal(encodeAck(frame).t, ACK_TYPE);
  for (const bad of [{ ctr: 0 }, { ctr: 1.5 }, { dir: 'x' }, { pair: 'nope' }])
    assert.equal(parseAck({ ...encodeAck(frame), ...bad }), null);
});

test('each role acks the direction it receives on; a relay advertises acks in its hello', () => {
  assert.deepEqual([incomingDir('mac'), incomingDir('phone')], ['p2m', 'm2p']);
  assert.deepEqual([relayAcks({ acks: true }), relayAcks({}), relayAcks(null), relayAcks({ acks: 'yes' })], [true, false, false, false]);
});

test('a receipt goes out for every final outcome and never for a retry, a hello or a relay without acks', () => {
  const sent: object[] = [];
  let enabled = true;
  const acker = new ReceiptAcker({ send: (m) => (sent.push(m), true), enabled: () => enabled });
  for (const o of ['accepted', 'duplicate', 'dropped'] as const) assert.equal(acker.settle(frame, o), true);
  assert.equal(acker.settle(frame, 'retry'), false);
  assert.equal(acker.settle({ ...frame, ctr: 0 }, 'accepted'), false);
  enabled = false;
  assert.equal(acker.settle(frame, 'accepted'), false);
  assert.equal(sent.length, 3);
  const refusing = new ReceiptAcker({ send: () => false, enabled: () => true });
  assert.equal(refusing.settle(frame, 'accepted'), false, 'a socket that refused the ack says so');
  const silent = new ReceiptAcker({ send: (() => undefined) as any, enabled: () => true });
  assert.equal(silent.settle(frame, 'accepted'), false, 'a send that reports nothing is not an ack');
});
