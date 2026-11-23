// MoMo's "needs you" names its card (electron/momo/notices.cjs → electron/platform/notify.cjs → notifyPush.cjs → relay): the card an approval or ACP question put up travels as an opaque handle on the momoNeedsYou push, is absent when no card was named, and is left out once the card was answered or went away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chatRef } from '../shared/remote/ref.mjs';
import { apnsBody, fcmMessage } from '../relay/src/pushPayload.mjs';
import { acpFormCardId, ACP_FORM_CARD } from '../shared/panelCardIds.mjs';

const require = createRequire(import.meta.url);
const { createMomoNotices, cardUp } = require('../electron/momo/notices.cjs');
const { Notifier } = require('../electron/platform/notify.cjs');
const { createPushRequests } = require('../electron/platform/notifyPush.cjs');

const at = (h: number, m = 0) => new Date(2030, 0, 15, h, m).getTime();

/** The real Notifier and push requests behind MoMo's notices; `up` is the set of cards still up. */
function rig(o: { prefs?: any; time?: number } = {}) {
  const state = { time: o.time ?? at(12), up: new Set<string>(['a1']), prefs: o.prefs ?? { momo: { routines: { quietHours: null } } } };
  const reqs: any[] = [];
  const banners: any[] = [];
  const opened: any[] = [];
  const timers: (() => void)[] = [];
  const push = createPushRequests({ pairs: () => ['p1'], sink: (r: any) => reqs.push(r) });
  const notifier = new Notifier({
    getMode: () => 'always',
    now: () => state.time,
    show: () => ({ close() {} }),
    onBanner: (b: any) => (banners.push(b), push.onBanner(b)),
  });
  const notices = createMomoNotices({
    notifier,
    allowed: () => true,
    prefs: () => state.prefs,
    open: (t: any) => opened.push(t),
    cardUp: (chatId: string, cardId: string) => chatId === 'm1' && state.up.has(cardId),
    now: () => state.time,
    schedule: (fn: () => void) => (timers.push(fn), fn),
    cancel: () => undefined,
  });
  return { state, reqs, banners, opened, notifier, notices, timers };
}

test('a needs-you that names a card pushes its handle, never the id; one without a card pushes none', () => {
  const r = rig();
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'm1', cardId: 'a1' }), true);
  assert.equal(r.banners[0].cardId, 'a1');
  assert.deepEqual(r.reqs[0], { pair: 'p1', kind: 'momoNeedsYou', ref: chatRef('p1', 'momo:chat:m1'), card: chatRef('p1', 'a1') });
  assert.ok(!JSON.stringify(r.reqs).includes('"a1"'));
  // an old caller (a nudge) names no card: the push opens the chat as before
  r.notices.needsYou({ kind: 'chat', chatId: 'm2' });
  assert.equal('cardId' in r.banners[1], false);
  assert.equal('card' in r.reqs[1], false);
  // an invalid card id is dropped, not sent
  r.notices.needsYou({ kind: 'chat', chatId: 'm3', cardId: 7 } as any);
  r.notices.needsYou({ kind: 'chat', chatId: 'm4', cardId: 'x'.repeat(257) });
  assert.equal(r.reqs.slice(2).filter((q: any) => 'card' in q).length, 0);
});

test('a card answered before quiet hours end is left out of the late notice; a click opens the chat without it', () => {
  const r = rig({ prefs: { momo: { routines: { quietHours: { enabled: true, start: '22:00', end: '07:00' } } } }, time: at(23) });
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'm1', cardId: 'a1' }), false);
  assert.equal(r.reqs.length, 0);
  // answered meanwhile
  r.state.up.delete('a1');
  r.state.time = at(8);
  r.timers.shift()!();
  assert.equal(r.reqs.length, 1);
  assert.equal('card' in r.reqs[0], false);
  assert.equal(r.notices.click('momo:chat:m1'), true);
  assert.deepEqual(r.opened, [{ kind: 'chat', chatId: 'm1' }]);
});

test('a card still up when quiet hours end, or when clicked, stays named', () => {
  const r = rig({ prefs: { momo: { routines: { quietHours: { enabled: true, start: '22:00', end: '07:00' } } } }, time: at(23) });
  r.notices.needsYou({ kind: 'chat', chatId: 'm1', cardId: 'a1' });
  r.state.time = at(8);
  r.timers.shift()!();
  assert.equal(r.reqs[0].card, chatRef('p1', 'a1'));
  r.notices.click('momo:chat:m1');
  assert.deepEqual(r.opened, [{ kind: 'chat', chatId: 'm1', cardId: 'a1' }]);
});

test('notices default to treating a named card as up', () => {
  const reqs: any[] = [];
  const push = createPushRequests({ pairs: () => ['p1'], sink: (q: any) => reqs.push(q) });
  const notifier = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }), onBanner: push.onBanner });
  const prefs = { momo: { routines: { quietHours: null } } };
  const notices = createMomoNotices({ notifier, allowed: () => true, prefs: () => prefs, open: () => undefined });
  notices.needsYou({ kind: 'chat', chatId: 'm1', cardId: 'z' });
  assert.equal(reqs[0].card, chatRef('p1', 'z'));
});

test('the Notifier hands its quiet hook what notify() was given, and passes only a string card to onBanner', () => {
  const seen: any[] = [];
  const banners: any[] = [];
  const n = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }), onBanner: (b: any) => banners.push(b) });
  n.setQuiet((kind: string, chatId: string, opts: any) => (seen.push([kind, chatId, opts?.cardId]), false));
  n.notify('approval', 'c1', { title: 't', cardId: 'k1' });
  n.notify('approval', 'c2', { title: 't', cardId: 5 });
  n.notify('approval', 'c3', { title: 't', cardId: '' });
  assert.deepEqual(seen, [
    ['approval', 'c1', 'k1'],
    ['approval', 'c2', 5],
    ['approval', 'c3', ''],
  ]);
  assert.equal(banners[0].cardId, 'k1');
  assert.equal('cardId' in banners[1], false);
  assert.equal('cardId' in banners[2], false);
});

test('other push kinds never carry a card, whatever the banner named', () => {
  const reqs: any[] = [];
  const push = createPushRequests({ pairs: () => ['p1'], sink: (q: any) => reqs.push(q) });
  push.onBanner({ kind: 'approval', chatId: 'c1', needs: true, cardId: 'a1' });
  assert.deepEqual(reqs, [{ pair: 'p1', kind: 'needsYou', ref: chatRef('p1', 'c1') }]);
});

test('cardUp: an approval or a pending ACP question of the chat is up; an answered one, another chat or no state is not', () => {
  const chats = new Map<string, any>([
    [
      'm1',
      {
        approvals: [{ id: 'a1' }, { id: 42 }],
        questions: [
          { id: 'q1', status: 'pending' },
          { id: 'q2', status: 'answered' },
        ],
      },
    ],
    ['m2', {}],
  ]);
  const state = { has: (id: string) => chats.has(id), get: (id: string) => chats.get(id) };
  assert.equal(cardUp(state, 'm1', 'a1'), true);
  assert.equal(cardUp(state, 'm1', '42'), true);
  assert.equal(cardUp(state, 'm1', acpFormCardId('q1')), true);
  assert.equal(cardUp(state, 'm1', acpFormCardId('q2')), false);
  assert.equal(cardUp(state, 'm1', 'gone'), false);
  assert.equal(cardUp(state, 'm2', 'a1'), false);
  assert.equal(cardUp(state, 'nope', 'a1'), false);
  assert.equal(cardUp(null, 'm1', 'a1'), false);
  // a state without has() is read as is
  assert.equal(cardUp({ get: () => undefined }, 'm1', 'a1'), false);
  assert.equal(acpFormCardId('q1'), `${ACP_FORM_CARD}q1`);
});

test('the provider payloads carry the card handle beside kind and ref, and none when it is absent', () => {
  const base = {
    platform: 'apns' as const,
    token: 't',
    kind: 'momoNeedsYou',
    title: 'MoMo needs you',
    count: 1,
    collapseId: 'c',
    ref: 'r',
  };
  assert.equal((apnsBody({ ...base, card: 'h1' }) as any).card, 'h1');
  assert.equal((fcmMessage({ ...base, card: 'h1' }) as any).data.card, 'h1');
  assert.equal('card' in (apnsBody(base) as any), false);
  assert.equal('card' in (fcmMessage(base) as any).data, false);
});

test('a chat that asks for approval names the card on its banner, and an ACP question names its card id', async () => {
  const { setup } = await import('./support/controller-coverage/setup.ts');
  const said: any[] = [];
  const { c } = setup({ ctl: { notify: (_k: string, _id: string, o: any) => said.push(o.cardId) } });
  c.addApproval('cx1', { id: 7, method: 'item/commandExecution/requestApproval', params: {} });
  assert.deepEqual(said, ['7']);
  const { SessionStore } = require('../electron/session/state.cjs');
  const { ControllerEvents } = require('../electron/session/controllerEvents.cjs');
  const asked: any[] = [];
  const controller = {
    state: new SessionStore(),
    chatOf: () => 'chat',
    isCurrentSource: () => true,
    say: (...a: any[]) => asked.push(a),
    learnSavedName: () => undefined,
    afterName: (_id: string, fn: () => void) => fn(),
  };
  ControllerEvents.prototype.onAcpEvent.call(controller, {
    key: 'acp:fake:one',
    kind: 'question',
    question: { id: 'q9', status: 'pending', harness: 'Fake' },
    questions: [{ id: 'q9', kind: 'question', status: 'pending' }],
  });
  assert.equal(asked[0][2].cardId, acpFormCardId('q9'));
});

test('the relay client sends the card only when there is one', () => {
  const { RelayClient } = require('../electron/remote/relayClient.cjs');
  const sent: any[] = [];
  const self = { request: (m: any) => (sent.push(m), Promise.resolve('sent')) };
  RelayClient.prototype.pushRequest.call(self, { pair: 'p', kind: 'momoNeedsYou', ref: 'r', card: 'h' });
  RelayClient.prototype.pushRequest.call(self, { pair: 'p', kind: 'momoNeedsYou', ref: 'r' });
  RelayClient.prototype.pushRequest.call(self, { pair: 'p', kind: 'needsYou', ref: 'r', sealed: 's' });
  // a Host's MoMo push carries the lease of its home sealed for the phone, which the phone uses to drop a push from an older one
  RelayClient.prototype.pushRequest.call(self, { pair: 'p', kind: 'momoNeedsYou', ref: 'r', sealedStamp: 'SEALED' });
  assert.deepEqual(sent, [
    { t: 'push', pair: 'p', kind: 'momoNeedsYou', ref: 'r', card: 'h' },
    { t: 'push', pair: 'p', kind: 'momoNeedsYou', ref: 'r' },
    { t: 'push', pair: 'p', kind: 'needsYou', ref: 'r', sealed: 's' },
    { t: 'push', pair: 'p', kind: 'momoNeedsYou', ref: 'r', sealedStamp: 'SEALED' },
  ]);
});
