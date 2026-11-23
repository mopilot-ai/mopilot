// A needs-you push for a card waiting in a MoMo channel (A2, #4846; electron/momo/notices.cjs → platform/notify.cjs → notifyPush.cjs → relay): `ref` is the handle of the CHANNEL's id (a phone that lists its channels recomputes it; it never knows a chat id), `card` the handle of the card, and nothing else about either goes: no id, no name, no text. The lock-screen text stays "MoMo needs you". The Mac's own click opens the channel's chat on the card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chatRef } from '../shared/remote/ref.mjs';
import { apnsBody, fcmMessage } from '../relay/src/pushPayload.mjs';

const require = createRequire(import.meta.url);
const { createMomoNotices } = require('../electron/momo/notices.cjs');
const { Notifier } = require('../electron/platform/notify.cjs');
const { createPushRequests } = require('../electron/platform/notifyPush.cjs');
const { MOMO_NOTICE_TITLES } = require('../shared/momoNotices.mjs');

const CHANNEL = 'ch_00000000000000aa';
const NAME = 'Kitchen plans';

function rig(channelOf?: (chatId: string) => string | null) {
  const reqs: any[] = [];
  const shown: any[] = [];
  const opened: any[] = [];
  const push = createPushRequests({ pairs: () => ['p1'], sink: (r: any) => reqs.push(r) });
  const notifier = new Notifier({
    getMode: () => 'always',
    show: (n: any) => (shown.push(n), { close() {} }),
    onBanner: push.onBanner,
  });
  const notices = createMomoNotices({
    notifier,
    allowed: () => true,
    prefs: () => ({ momo: { routines: { quietHours: null } } }),
    open: (t: any) => opened.push(t),
    ...(channelOf ? { channelOf } : {}),
  });
  return { reqs, shown, opened, notices };
}

test('a channel’s card pushes the channel’s handle as ref and the card’s as card, and nothing that names either', () => {
  const r = rig((chatId) => (chatId === 'chan-chat' ? CHANNEL : null));
  r.notices.needsYou({ kind: 'chat', chatId: 'chan-chat', cardId: 'a1' });
  assert.deepEqual(r.reqs, [{ pair: 'p1', kind: 'momoNeedsYou', ref: chatRef('p1', CHANNEL), card: chatRef('p1', 'a1') }]);
  // what the relay forwards to the provider holds only those handles
  const sent = r.reqs[0];
  for (const wire of [JSON.stringify(apnsBody({ ...sent, count: 1 } as any)), JSON.stringify(fcmMessage({ ...sent, count: 1 } as any))]) {
    for (const secret of [CHANNEL, NAME, 'chan-chat', 'a1']) assert.ok(!wire.includes(secret), `the push carries ${secret}`);
  }
  // the text is the fixed title, with no body
  assert.equal(r.shown[0].title, MOMO_NOTICE_TITLES.needsYou);
  assert.equal(r.shown[0].body, '');
});

test('main’s card and a chat that is no channel’s push as before: ref of the notice key, no channel', () => {
  const r = rig((chatId) => (chatId === 'chan-chat' ? CHANNEL : null));
  r.notices.needsYou({ kind: 'chat', chatId: 'main-chat', cardId: 'a2' });
  assert.deepEqual(r.reqs[0], { pair: 'p1', kind: 'momoNeedsYou', ref: chatRef('p1', 'momo:chat:main-chat'), card: chatRef('p1', 'a2') });
  // an old wiring with no channel lookup at all
  const plain = rig();
  plain.notices.needsYou({ kind: 'chat', chatId: 'chan-chat', cardId: 'a1' });
  assert.equal(plain.reqs[0].ref, chatRef('p1', 'momo:chat:chan-chat'));
  // a lookup that answers nothing usable names no channel
  const empty = rig(() => '' as any);
  empty.notices.needsYou({ kind: 'chat', chatId: 'chan-chat' });
  assert.equal(empty.reqs[0].ref, chatRef('p1', 'momo:chat:chan-chat'));
});

test('the Mac’s click on a channel’s notice opens that channel’s chat on its card', () => {
  const r = rig(() => CHANNEL);
  r.notices.needsYou({ kind: 'chat', chatId: 'chan-chat', cardId: 'a1' });
  assert.equal(r.notices.click('momo:chat:chan-chat'), true);
  assert.deepEqual(r.opened, [{ kind: 'chat', chatId: 'chan-chat', cardId: 'a1' }]);
});

test('a channel’s push carries the A6 sealed body next to its handles, sealed for the same ref the phone receives, and the text stays fixed', () => {
  const reqs: any[] = [];
  const sealedWith: string[][] = [];
  const push = createPushRequests({
    pairs: () => ['p1'],
    sink: (r: any) => reqs.push(r),
    bodyOf: (chatId: string) => (chatId === 'chan-chat' ? 'Morning brief' : ''),
    sealBody: (pair: string, ref: string, text: string) => (sealedWith.push([pair, ref, text]), `sealed:${ref}`),
  });
  push.onBanner({ kind: 'momo', chatId: 'chan-chat', needs: true, chatTitle: '', cardId: 'a1', channelId: CHANNEL });
  assert.deepEqual(reqs, [
    {
      pair: 'p1',
      kind: 'momoNeedsYou',
      ref: chatRef('p1', CHANNEL),
      card: chatRef('p1', 'a1'),
      sealedBody: `sealed:${chatRef('p1', CHANNEL)}`,
    },
  ]);
  assert.deepEqual(sealedWith, [['p1', chatRef('p1', CHANNEL), 'Morning brief']]);
  // a chat with no routine behind it seals no body, and Main's ref is the chat's as before
  push.onBanner({ kind: 'momo', chatId: 'main-chat', needs: true, chatTitle: '' });
  assert.equal('sealedBody' in reqs[1], false);
  assert.equal(reqs[1].ref, chatRef('p1', 'main-chat'));
});
