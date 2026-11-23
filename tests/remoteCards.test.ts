// A phone answering a card is checked as a window is: it follows the chat, the card is up, its rev is not older, the key was offered; the first valid answer wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, settle, CARD_CHOICES } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { PANEL } = require('../electron/remote/service.cjs');

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const fail = (r: any, code: string, message?: RegExp) => {
  assert.equal(r.ok, false, 'expected a refusal');
  assert.equal(r.error.code, code, r.error.message);
  if (message) assert.match(r.error.message, message);
};
const answered = (r: any) => r.calls.filter((c: any[]) => c[0] === 'answer').map((c: any[]) => c[1]);

/** A chat with one card up at a known rev, followed by p1. */
async function followed(o: any = {}) {
  const r = rig(o);
  r.state.patch('c1', { approvals: [{ id: 'a1', method: 'x', params: {} }] });
  const p = r.phone('p1');
  const snap = ok(await p.ask('chat.follow', { chatId: 'c1' }));
  return { r, p, rev: snap.rev as number };
}

test('a valid answer reaches the same path a window’s does, with the card’s version', async () => {
  const { r, p, rev } = await followed();
  assert.deepEqual(ok(await p.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev, key: 'once', values: { a: 1 } })), { answered: true });
  assert.deepEqual(answered(r), [{ chatId: 'c1', approvalId: 'a1', choice: 'once', version: 'v1', values: { a: 1 } }]);
});

test('a device that does not follow the chat may not answer its cards', async () => {
  const { r, p, rev } = await followed();
  const other = r.phone('p2');
  fail(await other.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev, key: 'once' }), 'forbidden', /Follow this chat/);
  await p.ask('chat.unfollow', { chatId: 'c1' });
  fail(await p.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev, key: 'once' }), 'forbidden');
  assert.deepEqual(answered(r), []);
});

test('an answer needs a rev, a card still up, a rev not older than the card’s, and a key the card offered', async () => {
  const { r, p, rev } = await followed();
  fail(await p.ask('card.answer', { chatId: 'c1', cardId: 'a1', key: 'once' }), 'invalid', /version of the card/);
  fail(await p.ask('card.answer', { chatId: 'c1', cardId: 'gone', rev, key: 'once' }), 'stale', /already answered/);
  fail(await p.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev, key: 'sudo' }), 'invalid', /offered by this request/);
  // the card is raised again (the same id, a new request) at a later rev: an answer to the earlier one is stale
  r.cards.c1 = [{ id: 'a1', title: 'Run?', detail: null, choices: CARD_CHOICES, version: 'v9' }];
  r.state.patch('c1', { approvals: [{ id: 'a1', method: 'x', params: { again: true } }] });
  await settle();
  const raised = p.events('cards.changed').at(-1).rev;
  assert.ok(raised > rev);
  fail(await p.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev, key: 'once' }), 'stale');
  assert.deepEqual(ok(await p.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev: raised, key: 'once' })), { answered: true });
  assert.deepEqual(
    answered(r).map((a: any) => a.version),
    ['v9'],
  );
});

test('a card the ledger never saw counts as raised at the rev the answer is checked at', async () => {
  const r = rig();
  const p = r.phone('p1');
  ok(await p.ask('chat.follow', { chatId: 'c1' }));
  r.state.patch('c1', { plan: true });
  r.cards.c1 = [{ id: 'late', title: 'Late', detail: null, choices: CARD_CHOICES, version: 'vl' }];
  const rev = r.state.get('c1').rev;
  fail(await p.ask('card.answer', { chatId: 'c1', cardId: 'late', rev: rev - 1, key: 'once' }), 'stale');
  ok(await p.ask('card.answer', { chatId: 'c1', cardId: 'late', rev, key: 'once' }));
});

test('a choice that makes an allowance permanent needs the Mac to allow it; a card for the Mac’s screen is not a phone’s', async () => {
  const strict = await followed();
  fail(await strict.p.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev: strict.rev, key: 'similar' }), 'forbidden', /from your Mac/);
  const open = await followed({ policy: { allowPersistent: () => true } });
  ok(await open.p.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev: open.rev, key: 'similar' }));
  const inApp = await followed();
  inApp.r.cards.c1 = [{ id: 'a1', title: 'Finish on the Mac', inApp: true, version: 'v1' }];
  fail(
    await inApp.p.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev: inApp.rev, key: 'once' }),
    'forbidden',
    /Finish this on your Mac/,
  );
  // a form with no listed choices takes any key the native owner then validates
  const form = await followed();
  form.r.cards.c1 = [{ id: 'a1', title: 'Form', detail: null, version: 'v1' }];
  ok(await form.p.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev: form.rev, key: 'submit', values: { x: 1 } }));
});

test('the first valid answer from any surface wins; later ones are stale', async () => {
  const { r, p, rev } = await followed();
  const q = r.phone('p2');
  ok(await q.ask('chat.follow', { chatId: 'c1' }));
  ok(await p.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev, key: 'once' }));
  fail(await q.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev, key: 'deny' }), 'stale');
  assert.equal(answered(r).length, 1);
  // a window answered first: the card is still listed when the phone asks, but the path says it is gone
  const w = await followed({ ops: { answer: async () => false } });
  fail(await w.p.ask('card.answer', { chatId: 'c1', cardId: 'a1', rev: w.rev, key: 'once' }), 'stale', /already answered/);
});

test('a retried answer is replayed, not delivered twice', async () => {
  const { r, p, rev } = await followed();
  const params = { chatId: 'c1', cardId: 'a1', rev, key: 'once' };
  await p.ask('card.answer', params, 'dup');
  await p.ask('card.answer', params, 'dup');
  assert.equal(answered(r).length, 1);
  const replies = p.inbox.filter((m) => m.inReplyTo === 'dup');
  assert.equal(replies.length, 2);
  assert.deepEqual(replies[1].result, { answered: true });
});

test('the panel answers by approval id and version, as it always did', async () => {
  const r = rig();
  assert.deepEqual(await r.service.call(PANEL, 'card.answer', { chatId: 'c1', cardId: 'a1', key: 'once', version: 'v1' }), {
    answered: true,
  });
  assert.deepEqual(answered(r), [{ chatId: 'c1', approvalId: 'a1', choice: 'once', version: 'v1' }]);
  await assert.rejects(r.service.call(PANEL, 'card.answer', { chatId: 'c1', cardId: 'a1', key: 'once' }), /already answered/);
  assert.deepEqual(answered(r).at(-1), { chatId: 'c1', approvalId: 'a1', choice: 'once' });
});
