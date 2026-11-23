// A phone the relay says is away is sent no live stream: the frames would only wait at the relay as a backlog, and the phone reads the chat again when it returns. Cards and the rest of the traffic are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, settle } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { createPhonePresence } = require('../electron/remote/phonePresence.cjs');
const delta = (n: number) => ({ ev: 'items.delta', chatId: 'c1', itemId: 'm', field: 'text', text: `t${n} ` });

async function streamed(absent: Set<string>, turns = 100) {
  const r = rig({ phoneAbsent: (pair) => absent.has(pair) });
  const p1 = r.phone('p1');
  const p2 = r.phone('p2');
  await p1.ask('chat.follow', { chatId: 'c1', items: 5 });
  await p2.ask('chat.follow', { chatId: 'c1', items: 5 });
  const before = [p1.events('items.delta').length, p2.events('items.delta').length];
  for (let i = 0; i < turns; i++) r.service.onFeedEvent(delta(i));
  r.service.onFeedEvent({ ev: 'turn.state', chatId: 'c1', turnId: 't', status: 'completed' });
  await settle();
  return { p1: p1.events('items.delta').length - before[0], p2: p2.events('items.delta').length - before[1], p1all: p1.events(), r };
}

test('a streaming turn queues nothing for a phone that is away, and every frame for one that is not', async () => {
  const none = await streamed(new Set());
  assert.equal(none.p1, 100);
  assert.equal(none.p2, 100);
  const away = await streamed(new Set(['p1']));
  assert.equal(away.p1, 0, 'frames queued for the absent phone: 100 before, 0 after');
  assert.equal(away.p2, 100, 'the connected phone gets the whole stream');
  assert.equal(away.p1all.filter((e: any) => e.ev === 'turn.state').length, 0);
});

test('the default is to send, so a Mac with no presence source behaves as before', async () => {
  const r = rig();
  const p = r.phone('p1');
  await p.ask('chat.follow', { chatId: 'c1', items: 5 });
  r.service.onFeedEvent(delta(1));
  await settle();
  assert.equal(p.events('items.delta').length, 1);
});

test('absence is only believed when the relay reports phones and this Mac is connected', () => {
  const handlers: Record<string, Array<(v: any) => void>> = {};
  const relay = { on: (kind: string, fn: (v: any) => void) => ((handlers[kind] ??= []).push(fn), () => {}) };
  const presence = createPhonePresence(relay);
  const emit = (kind: string, v: any) => handlers[kind]!.forEach((fn) => fn(v));
  assert.equal(presence.isAbsent('p1'), false, 'nothing is known before the relay says hello');
  emit('open', { pairs: [{ pair: 'p1', role: 'mac', peerOnline: false }], peerEvents: false });
  assert.equal(presence.isAbsent('p1'), false, 'an older relay does not report phones');
  emit('open', {
    pairs: [
      { pair: 'p1', role: 'mac', peerOnline: false },
      { pair: 'p2', role: 'mac', peerOnline: true },
    ],
    peerEvents: true,
  });
  assert.equal(presence.isAbsent('p1'), true);
  assert.equal(presence.isAbsent('p2'), false);
  emit('event', { ev: 'peer', pair: 'p1', online: true });
  assert.equal(presence.isAbsent('p1'), false, 'it is sent to again the moment the phone arrives');
  emit('state', 'closed');
  assert.equal(presence.isAbsent('p3'), false, 'with this Mac offline, absence means nothing');
});
