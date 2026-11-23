// Which paired phones are online for Settings (electron/remote/phonePresence.cjs): the relay's hello and its `peer` events while the
// Mac's socket is open; nothing while it is down, and nothing from a relay that never sends phone `peer` events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPhonePresence } = require('../electron/remote/phonePresence.cjs');

function fakeRelay() {
  const handlers: Record<string, ((v: any) => void)[]> = { state: [], open: [], event: [] };
  return {
    on: (kind: string, fn: (v: any) => void) => (handlers[kind].push(fn), () => {}),
    emit: (kind: string, v: any) => handlers[kind].forEach((fn) => fn(v)),
  };
}
const mac = (pair: string, peerOnline: unknown) => ({ pair, role: 'mac', joined: true, peerOnline });

test('the hello says which phones are connected; peer events keep it current', () => {
  const relay = fakeRelay();
  const presence = createPhonePresence(relay);
  assert.equal(presence.isOnline('pa'), false, 'nothing is known before the hello');
  relay.emit('state', 'open');
  relay.emit('open', {
    pairs: [mac('pa', true), mac('pb', false), { pair: 'pc', role: 'phone', peerOnline: true }, null, mac(7 as any, true)],
    peerEvents: true,
  });
  assert.deepEqual(['pa', 'pb', 'pc'].map(presence.isOnline), [true, false, false], 'only this Mac’s own pairs count');
  relay.emit('event', { ev: 'peer', pair: 'pb', online: true });
  relay.emit('event', { ev: 'peer', pair: 'pa', online: false });
  assert.deepEqual(['pa', 'pb'].map(presence.isOnline), [false, true]);
  relay.emit('event', { ev: 'peer', pair: 3 });
  relay.emit('event', { ev: 'pair.joined', pair: 3 });
  relay.emit('event', { ev: 'mailbox.dropped', pair: 'pa' });
  relay.emit('event', null);
  assert.deepEqual(['pa', 'pb'].map(presence.isOnline), [false, true], 'other events change nothing');
  relay.emit('event', { ev: 'pair.joined', pair: 'pn' });
  assert.equal(presence.isOnline('pn'), true, 'a phone that just paired is connected');
});

test("the Mac's own socket going down makes every phone unknown again", () => {
  const relay = fakeRelay();
  const presence = createPhonePresence(relay);
  relay.emit('open', { pairs: [mac('pa', true)], peerEvents: true });
  assert.equal(presence.isOnline('pa'), true);
  relay.emit('state', 'backoff');
  assert.equal(presence.isOnline('pa'), false);
});

test('a relay that sends no phone peer events is not trusted: its hello would never change', () => {
  const relay = fakeRelay();
  const presence = createPhonePresence(relay);
  relay.emit('open', { pairs: [mac('pa', true)], peerEvents: false });
  relay.emit('event', { ev: 'pair.joined', pair: 'pn' });
  assert.deepEqual(['pa', 'pn'].map(presence.isOnline), [false, false]);
});

test('markPresent ignores a frame received within the grace after the relay said the phone was away, and takes a fresh one after it', () => {
  let at = 0;
  const relay = fakeRelay();
  const presence = createPhonePresence(
    relay,
    () => at,
    () => 1_000,
  );
  relay.emit('open', { pairs: [mac('pa', true), mac('pb', false)], peerEvents: true });
  at = 10;
  relay.emit('event', { ev: 'peer', pair: 'pa', online: false });
  for (const receivedAt of [9, 10, 5_010, undefined as any]) presence.markPresent('pa', receivedAt, 1_000);
  assert.equal(presence.isOnline('pa'), false, 'before, at the same time, within 5 s after, or at an unknown time: not present');
  presence.markPresent('pa', 5_011, 1_000);
  assert.equal(presence.isOnline('pa'), true);
  presence.markPresent('pb', 4_999, 1_000);
  assert.equal(presence.isOnline('pb'), false, 'a hello that lists the phone offline counts too: its backlog follows it at once');
  presence.markPresent('pb', 5_001, 1_000);
  assert.equal(presence.isOnline('pb'), true);
  presence.markPresent('pn', 5, 1_000);
  assert.equal(presence.isOnline('pn'), true, 'a phone the relay never said was away takes a frame at any time');
});

test("markPresent needs the message time, from the phone's sealed payload, within two minutes of the Mac's clock", () => {
  const relay = fakeRelay();
  const wall = { at: 10_000_000 };
  const presence = createPhonePresence(
    relay,
    () => 0,
    () => wall.at,
  );
  relay.emit('open', { pairs: [mac('pa', false)], peerEvents: true });
  const later = 1_000_000;
  const heard = (sentAt: any) => (presence.markPresent('pa', later, sentAt), presence.isOnline('pa'));
  assert.equal(heard(wall.at - 120_001), false, 'older than two minutes');
  assert.equal(heard(wall.at + 120_001), false, 'a clock that far ahead');
  assert.equal(heard(undefined), false, 'no time');
  assert.equal(heard('x'), false, 'no time');
  assert.equal(heard(wall.at - 120_000), true, 'two minutes exactly is fresh');
});

test('markPresent changes nothing for a relay that does not report phones or while the Mac socket is down', () => {
  const relay = fakeRelay();
  const presence = createPhonePresence(
    relay,
    () => 0,
    () => 5,
  );
  relay.emit('open', { pairs: [mac('pa', false)], peerEvents: false });
  presence.markPresent('pa', 1e9, 5);
  assert.equal(presence.isOnline('pa'), false);
  relay.emit('open', { pairs: [mac('pa', false)], peerEvents: true });
  relay.emit('state', 'closed');
  presence.markPresent('pa', 1e9, 5);
  assert.equal(presence.isOnline('pa'), false);
});
