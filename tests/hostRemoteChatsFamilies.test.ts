// A Codex or Claude Code chat on a Host in the mirror (electron/host/remoteChats.cjs, turnStartPairs.cjs): their turn events are the ACP-shaped ones, but a turn start names no user message; the Host's `user` item says what was asked, before or after it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world } from './support/host/remoteChatsKit.ts';
const require = createRequire(import.meta.url);
const { createStartPairs } = require('../electron/host/turnStartPairs.cjs');

const CODEX = 'acp:host-codex:u1';
const CLAUDE = 'acp:host-claude:u2';
const fam = (family: string, event: object) => ({ t: 'event', family, event });
const begin = (family: string, turnId: string) => fam(family, { kind: 'turnStart', turnId });
const said = (turnId: string, text: string) => ({ t: 'user', turnId, text });
const chunk = (family: string, turnId: string, text: string) =>
  fam(family, {
    kind: 'update',
    turnId,
    update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } },
  });
const done = (family: string, turnId: string) => fam(family, { kind: 'turnEnd', turnId, stopReason: 'end_turn' });
const USER = (turnId: string, text: string) => ({
  id: `u-${turnId}`,
  clientId: turnId,
  content: text ? [{ type: 'text', text, text_elements: [] }] : [],
});

for (const [name, chatId, family, order] of [
  ['Codex, start first', CODEX, 'codex', 'start-first'],
  ['Codex, the user item first', CODEX, 'codex', 'user-first'],
  ['Claude Code, start first', CLAUDE, 'claude', 'start-first'],
  ['Claude Code, the user item first', CLAUDE, 'claude', 'user-first'],
] as const) {
  test(`${name}: the turn is shown and recorded as an ACP turn is, with the text that was asked`, async () => {
    const w = world();
    w.chats.follow(chatId);
    await w.chats.settled(chatId);
    const first = order === 'start-first' ? begin(family, 't1') : said('t1', 'fix it');
    const second = order === 'start-first' ? said('t1', 'fix it') : begin(family, 't1');
    w.host.fire.patch(chatId, 1, first);
    w.host.fire.patch(chatId, 2, second);
    w.host.fire.patch(chatId, 3, chunk(family, 't1', 'done'));
    w.host.fire.patch(chatId, 4, done(family, 't1'));
    await w.chats.settled(chatId);
    assert.deepEqual(
      w.emitted.map((e) => e.kind),
      ['turnStart', 'update', 'turnEnd'],
    );
    assert.deepEqual(w.emitted[0], { kind: 'turnStart', turnId: 't1', user: USER('t1', 'fix it'), key: chatId });
    // the record is written once the turn is paired, at the revision that completed it
    const records = w.items.records.filter((r) => r.hostRev !== undefined);
    assert.deepEqual(
      records.map((r) => [r.t, r.hostRev]),
      [
        ['user', 2],
        ['update', 3],
        ['end', 4],
      ],
    );
    assert.deepEqual(records[0].user, USER('t1', 'fix it'));
    assert.deepEqual(w.chats.mirror(chatId)!.items, [
      { t: 'user', turnId: 't1', text: 'fix it' },
      { t: 'assistant', turnId: 't1', text: 'done', stopReason: 'end_turn', error: null },
    ]);
    assert.deepEqual(w.reported, []);
  });
}

test('a turn the agent began itself has no user item: its first event releases the start with no user message', async () => {
  const w = world();
  w.chats.follow(CLAUDE);
  await w.chats.settled(CLAUDE);
  w.host.fire.patch(CLAUDE, 1, begin('claude', 'auto1'));
  assert.deepEqual(w.emitted, [], 'held until the Host says what was asked');
  w.host.fire.patch(CLAUDE, 2, chunk('claude', 'auto1', 'background task done'));
  await w.chats.settled(CLAUDE);
  assert.deepEqual(
    w.emitted.map((e: any) => e.kind),
    ['turnStart', 'update'],
  );
  assert.deepEqual((w.emitted as any[])[0].user, USER('auto1', ''));
});

test('a permission card of a Codex or Claude Code chat is shown, answered through the mirror and closed like an ACP one', async () => {
  const w = world();
  const answers: any[] = [];
  w.host.answer = async (p: any) => (answers.push(p), { answered: true });
  w.chats.follow(CODEX);
  await w.chats.settled(CODEX);
  const card = {
    kind: 'permission',
    requestId: 'codex-g-1',
    turnId: 't1',
    toolCall: { title: 'ls', kind: 'execute' },
    options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
  };
  w.host.fire.patch(CODEX, 1, fam('codex', card));
  await w.chats.settled(CODEX);
  // in the app the card's id is the chat's own; the Host is answered with the id it gave
  assert.deepEqual(w.emitted, [{ ...card, requestId: `${CODEX}|codex-g-1`, key: CODEX }]);
  assert.equal(await w.chats.answer(`${CODEX}|codex-g-1`, 'allow_once'), true);
  assert.deepEqual(answers, [{ chatId: CODEX, requestId: 'codex-g-1', optionId: 'allow_once' }]);
});

test('an ACP turn start that carries its user message is not held, and the Host’s user item after it changes nothing', async () => {
  const w = world();
  const ACP = 'acp:kimi:c1';
  w.chats.follow(ACP);
  await w.chats.settled(ACP);
  w.host.fire.patch(ACP, 1, fam('acp', { kind: 'turnStart', turnId: 't1', user: { id: 'u1', content: [] } }));
  w.host.fire.patch(ACP, 2, said('t1', 'hi'));
  await w.chats.settled(ACP);
  assert.deepEqual(
    w.emitted.map((e) => e.kind),
    ['turnStart'],
  );
});

test('the pairing: items that are not a user message are ignored, and a Host that never completes a pair cannot grow it without end', () => {
  const pairs = createStartPairs();
  const start = (turnId: string) => ({ kind: 'turnStart', turnId });
  for (const item of [
    { t: 'assistant', turnId: 't', text: 'x' },
    { t: 'user', turnId: 7, text: 'x' },
    { t: 'user', turnId: 't', text: 7 },
    null,
  ])
    assert.deepEqual(pairs.take(item, null), []);
  // a user item with no turn start yet is kept for it
  assert.deepEqual(pairs.take(said('keep', 'asked'), null), []);
  assert.deepEqual(pairs.take(null, start('keep')), [{ kind: 'turnStart', turnId: 'keep', user: USER('keep', 'asked') }]);
  // more waiting than are kept: the oldest is forgotten
  for (let i = 0; i < 70; i++) pairs.take(null, start(`h${i}`));
  assert.deepEqual(pairs.take(said('h0', 'late'), null), [], 'the oldest start is gone, so its user item waits');
  assert.equal(pairs.take(said('h69', 'late'), null).length, 1, 'the newest is still there');
  for (let i = 0; i < 70; i++) pairs.take(said(`s${i}`, 'x'), null);
  assert.deepEqual(pairs.take(null, start('s0')), [], 'the oldest user item is gone, so its start waits');
  assert.equal(pairs.take(null, start('s69')).length, 1);
  // an event of a turn with nothing held passes as it is
  const other = { kind: 'update', turnId: 'nobody', update: {} };
  assert.deepEqual(pairs.take(null, other), [other]);
});

test('a new numbering from the Host forgets the starts and user items waiting for their pair', async () => {
  const w = world();
  w.chats.follow(CODEX);
  await w.chats.settled(CODEX);
  w.host.fire.patch(CODEX, 1, begin('codex', 't1'));
  w.host.fire.resync(CODEX, { rev: 5, items: [] }, 'g2');
  w.host.fire.patch(CODEX, 6, said('t1', 'new question'));
  await w.chats.settled(CODEX);
  assert.deepEqual(w.emitted, [], 'the old numbering’s held start is not paired with the new numbering’s t1');
});

test('the Host’s user item after an ACP turn start that carried its message is not kept for a later turn', () => {
  const pairs = createStartPairs();
  const first = { kind: 'turnStart', turnId: 't1', user: { id: 'u' } };
  assert.deepEqual(pairs.take(null, first), [first]);
  assert.deepEqual(pairs.take(said('t1', 'hi'), null), []);
  // nothing is left waiting for t1: a start with that id after a reset waits for its own user item
  assert.deepEqual(pairs.take(null, { kind: 'turnStart', turnId: 't1' }), []);
});
