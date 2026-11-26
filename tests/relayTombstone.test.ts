// A removed controller's relay link as a tombstone (host/src/relayTombstone.mjs, #5747): each stream hears only that the client was removed (ping aside), never anything the Host serves, and gives up after a few answers; the tombstones to forget are the ones past their time, then the oldest past the most kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { MAX_TOMBSTONES, TOMBSTONE_MS, expired, refuseStream, staleTombstones } from '../host/src/relayTombstone.mjs';
// @ts-ignore
import { encodeBinary, encodeControl } from '../shared/host/frames.mjs';

/** A stream as relaySession.mjs hands one to the Host, recording what is written and how it ends. */
function fakeStream() {
  const s: any = {
    written: [] as any[],
    consumedBytes: 0,
    ended: 0,
    resets: 0,
    write: (b: Uint8Array) => (
      s.written.push(
        ...Buffer.from(b)
          .toString()
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l)),
      ),
      true
    ),
    end: () => void s.ended++,
    reset: () => void s.resets++,
    consumed: (n: number) => void (s.consumedBytes += n),
  };
  return s;
}
const REMOVED = { code: 'unknown_client', details: { linkRemoved: true } };

test('every request but ping is refused as an unknown client marked linkRemoved: the auth, a pairing code and any other method alike', () => {
  const s = fakeStream();
  refuseStream(s);
  const lines = [
    { id: 1, method: 'ping' },
    { id: 2, method: 'host.challenge' },
    { id: 3, method: 'host.auth', params: { publicKey: 'k', nonce: 'n', signature: 's' } },
    { id: 4, method: 'host.pair', params: { code: '123456' } },
    { id: 5, method: 'status' },
    { method: 'chat.list' },
  ];
  const bytes = Buffer.concat(lines.map((l) => encodeControl(l)));
  s.onData(new Uint8Array(bytes));
  assert.equal(s.consumedBytes, bytes.length, 'what it read is granted back');
  assert.deepEqual(s.written[0], { id: 1, result: 'pong' });
  for (const [i, r] of s.written.slice(1).entries()) {
    assert.equal(r.id, i < 4 ? i + 2 : null);
    assert.equal(r.code, REMOVED.code);
    assert.deepEqual(r.details, REMOVED.details);
    assert.equal('result' in r, false, 'nothing is ever served');
  }
  // a binary frame is no way in either
  s.onData(new Uint8Array(encodeBinary({ id: 9, method: 'host.auth' }, new Uint8Array([1, 2]))));
  assert.equal(s.written.at(-1).code, 'unknown_client');
  s.onEnd();
  assert.equal(s.ended, 1, 'the other end ending ends this one');
  s.onReset('gone');
});

test('a stream that asks on and on is ended after a few answers; one that sends what is not a frame is reset', () => {
  const s = fakeStream();
  refuseStream(s);
  s.onData(new Uint8Array(Buffer.concat(Array.from({ length: 20 }, (_, i) => encodeControl({ id: i, method: 'host.auth' })))));
  assert.equal(s.written.length, 8);
  assert.equal(s.ended, 1);
  const bad = fakeStream();
  refuseStream(bad);
  bad.onData(new Uint8Array(Buffer.from('not json\n')));
  assert.equal(bad.resets, 1);
  assert.deepEqual(bad.written, []);
});

test('the tombstones to forget: past their time first, then the oldest past the most kept; links that are not tombstones never', () => {
  const now = 10 * TOMBSTONE_MS;
  assert.equal(expired({}, now), false);
  assert.equal(expired({ retiredAt: now - TOMBSTONE_MS + 1 }, now), false);
  assert.equal(expired({ retiredAt: now - TOMBSTONE_MS }, now), true);
  const live = Array.from({ length: MAX_TOMBSTONES + 2 }, (_, i) => ({ hostId: `h_live${i}`, retiredAt: now - 1000 + i }));
  const all = [{ hostId: 'h_link' }, { hostId: 'h_old', retiredAt: now - TOMBSTONE_MS - 5 }, ...[...live].reverse()];
  assert.deepEqual(staleTombstones(all, now), [
    { hostId: 'h_old', outcome: 'expired' },
    { hostId: 'h_live0', outcome: 'evicted' },
    { hostId: 'h_live1', outcome: 'evicted' },
  ]);
  assert.deepEqual(staleTombstones([{ hostId: 'h_link' }, ...live.slice(0, 3)], now), []);
});
