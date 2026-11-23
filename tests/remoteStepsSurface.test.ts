// A phone and a chat's computer, browser and Chrome work (electron/remote/methods/steps.cjs, phoneCards.cjs, card.cjs): a step picture and where the chat works, for a followed chat only; each card placed for the phone or the Mac; a payment and the hand-offs only the Mac finishes shown with what they wait for, never answered from the phone; and the followers told as a hand-off begins and ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, settle } from './support/remote-kit.ts';
import { parseParams } from '../shared/remote/schema.mjs';

const require = createRequire(import.meta.url);
const { placed, MAC_WAITS } = require('../electron/remote/phoneCards.cjs');
const { cardOf } = require('../electron/capabilities/browser/chromePanelCards.cjs');

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const fail = (r: any, code: string, message?: RegExp) => {
  assert.equal(r.ok, false, JSON.stringify(r.result));
  assert.equal(r.error.code, code, r.error.message);
  if (message) assert.match(r.error.message, message);
};
const waiting = (id: string) => ({
  id,
  title: 'Waiting for you on your Mac: sign in to a.test',
  inApp: true,
  where: 'mac-only',
  waitingCopy: 'Waiting for you on your Mac: sign in to a.test',
});

test('steps.thumbnail and surface.current: a followed chat only, the Mac’s answer as it is, {} when there is none', async () => {
  const asked: any[] = [];
  const r = rig({
    ops: {
      stepImage: async (...a: any[]) => (asked.push(a), a[1] === 'i1' ? { data: 'eA==', width: 2, height: 1 } : null),
      surface: async (id: string) => (id === 'c1' ? { kind: 'iab', title: 'T', origin: 'https://a.test' } : null),
    },
  });
  const p = r.phone('p1');
  fail(await p.ask('steps.thumbnail', { chatId: 'c1', callId: 'i1' }), 'forbidden', /Open this chat/);
  fail(await p.ask('surface.current', { chatId: 'c1' }), 'forbidden');
  fail(await p.ask('steps.thumbnail', { chatId: 'nope', callId: 'i1' }), 'gone');
  ok(await p.ask('chat.follow', { chatId: 'c1' }));
  ok(await p.ask('chat.follow', { chatId: 'c2' }));
  assert.deepEqual(ok(await p.ask('steps.thumbnail', { chatId: 'c1', callId: 'i1', maxSide: 5000 })), {
    data: 'eA==',
    width: 2,
    height: 1,
  });
  assert.deepEqual(asked[0], ['c1', 'i1', 1024], 'the side is capped');
  assert.deepEqual(ok(await p.ask('steps.thumbnail', { chatId: 'c1', callId: 'i9' })), {});
  assert.deepEqual(ok(await p.ask('surface.current', { chatId: 'c1' })), { kind: 'iab', title: 'T', origin: 'https://a.test' });
  assert.deepEqual(ok(await p.ask('surface.current', { chatId: 'c2' })), {});
  fail(await p.ask('steps.thumbnail', { chatId: 'c1' }), 'invalid', /step/);
  // an older Mac's operations without them answer {}
  const bare = rig();
  const q = bare.phone('p1');
  ok(await q.ask('chat.follow', { chatId: 'c1' }));
  assert.deepEqual(ok(await q.ask('steps.thumbnail', { chatId: 'c1', callId: 'i1' })), {});
  assert.deepEqual(ok(await q.ask('surface.current', { chatId: 'c1' })), {});
  // the side panel never asks for them
  await assert.rejects(r.service.call({ kind: 'panel' }, 'surface.current', { chatId: 'c1' }), /doesn't allow/);
});

test('the schema: a step’s id up to a row id’s size, the picture side within a phone’s range', () => {
  assert.deepEqual(parseParams('steps.thumbnail', { chatId: 'c1', callId: 'x' }), { chatId: 'c1', callId: 'x', maxSide: 360 });
  assert.equal((parseParams('steps.thumbnail', { chatId: 'c1', callId: 'x', maxSide: 1 }) as any).maxSide, 64);
  assert.equal((parseParams('steps.thumbnail', { chatId: 'c1', callId: 'x', maxSide: 2.5 }) as any).maxSide, 360);
  assert.throws(() => parseParams('steps.thumbnail', { chatId: 'c1', callId: 'x'.repeat(2049) }), /step/);
  assert.throws(() => parseParams('steps.thumbnail', { chatId: 'c1', callId: 7 }), /step/);
  assert.deepEqual(parseParams('surface.current', { chatId: 'c1' }), { chatId: 'c1' });
});

test('cards placed: the phone answers a card with controls; one with none, a payment and a hand-off are the Mac’s, said so', async () => {
  assert.deepEqual(placed({ id: 1, title: 'Run?', choices: [] }), { id: 1, title: 'Run?', choices: [], where: 'phone' });
  assert.deepEqual(placed({ id: 2, title: 'X is waiting', inApp: true }), {
    id: 2,
    title: 'X is waiting',
    inApp: true,
    where: 'mac-only',
    waitingCopy: MAC_WAITS,
  });
  assert.deepEqual(
    placed({ id: 3, title: 'Pay?', macOnly: true, waitingCopy: 'Waiting for you on your Mac: confirm the payment on a.test' }),
    {
      id: 3,
      title: 'Pay?',
      where: 'mac-only',
      waitingCopy: 'Waiting for you on your Mac: confirm the payment on a.test',
    },
  );
  // the Mac-only card itself, as the app builds it from the browser's confirmation (sage/approval computerConfirm), for each kind
  for (const [kind, ask] of [
    ['payment', 'confirm the payment'],
    ['payment_entry', 'confirm the payment'],
    ['purchase', 'confirm the payment'],
    ['transfer', 'confirm the transfer'],
    ['password_change', 'confirm the password change'],
    ['someday_kind', 'confirm the payment'],
  ]) {
    const card = cardOf(
      { id: 'p', method: 'sage/approval', params: { kind: 'computerConfirm', verb: 'x', app: { name: 'shop.test' }, macOnly: kind } },
      'Codex',
    );
    assert.deepEqual([card.macOnly, card.waitingCopy], [true, `Waiting for you on your Mac: ${ask} on shop.test`], kind);
  }
  const plain = cardOf(
    { id: 'q', method: 'sage/approval', params: { kind: 'computerConfirm', verb: 'delete', app: { name: 'shop.test' } } },
    'Codex',
  );
  assert.equal(plain.macOnly, undefined);
});

test('a phone sees the hand-offs with the chat’s cards; can’t answer them or a payment; hears them begin and end, once each', async () => {
  let listener: ((chatId: string) => void) | null = null;
  let offs = 0;
  let hand: any[] = [];
  const r = rig({
    ops: {
      waitingCards: (id: string) => (id === 'c1' ? hand : []),
      onCallChange: (fn: any) => ((listener = fn), () => void offs++),
    },
  });
  r.cards.c1.push({
    id: 'pay',
    title: 'Pay?',
    choices: [{ key: 'once', label: 'Allow once' }],
    macOnly: true,
    waitingCopy: 'W',
    version: 'v9',
  });
  const p = r.phone('p1');
  hand = [waiting('mac-signin:t1')];
  const snap = ok(await p.ask('chat.follow', { chatId: 'c1' }));
  assert.deepEqual(
    snap.session.cards.map((c: any) => [c.id, c.where]),
    [
      ['a1', 'phone'],
      ['pay', 'mac-only'],
      ['mac-signin:t1', 'mac-only'],
    ],
  );
  const rev = snap.rev;
  fail(await p.ask('card.answer', { chatId: 'c1', cardId: 'pay', key: 'once', rev }), 'forbidden', /on your Mac/);
  fail(await p.ask('card.answer', { chatId: 'c1', cardId: 'mac-signin:t1', key: 'x', rev }), 'forbidden', /on your Mac/);
  fail(await p.ask('card.answer', { chatId: 'c1', cardId: 'gone', key: 'x', rev }), 'stale');
  // the hand-off ends: the followers get the cards again; the same cards again are not news
  hand = [];
  listener!('c1');
  await settle();
  listener!('c1');
  await settle();
  hand = [waiting('mac-login:k1')];
  listener!('c1');
  await settle();
  const told = p.events('cards.changed');
  assert.equal(told.length, 2);
  assert.deepEqual(
    told.map((e: any) => e.cards.filter((c: any) => c.id.startsWith('mac-')).map((c: any) => c.id)),
    [[], ['mac-login:k1']],
  );
  assert.equal(told[0].chatId, 'c1');
  // a chat nobody follows is not told, and starts again from nothing
  listener!('c2');
  await settle();
  assert.equal(p.events('cards.changed').length, 2);
  r.service.detach();
  assert.equal(offs, 1, 'the service stops hearing the calls when it stops serving');
});

test('waiting cards: a followed chat with none and nothing told yet hears nothing; one whose state is gone is told at revision 0', async () => {
  let listener: ((chatId: string) => void) | null = null;
  let hand: any[] = [];
  const r = rig({ ops: { waitingCards: () => hand, onCallChange: (fn: any) => ((listener = fn), () => undefined) } });
  const p = r.phone('p1');
  ok(await p.ask('chat.follow', { chatId: 'c1' }));
  // nothing was told for this chat yet (the record is gone) and no hand-off is up: no event
  r.service.waiting.told.delete('c1');
  listener!('c1');
  await settle();
  assert.equal(p.events('cards.changed').length, 0);
  // a hand-off appears for a chat whose session state is gone: the cards go out at revision 0
  const state = r.ops.state;
  r.ops.state = { ...state, get: () => undefined };
  hand = [waiting('mac-signin:t9')];
  listener!('c1');
  await settle();
  assert.deepEqual(
    p.events('cards.changed').map((e: any) => [e.rev, e.cards.some((c: any) => c.id === 'mac-signin:t9')]),
    [[0, true]],
  );
});
