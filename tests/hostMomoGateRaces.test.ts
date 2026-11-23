// Things that happen at the same moment, through the real registry and gate: two devices allowing one card, an Allow beside a Deny, an Edit, an expiry or a move, and two answers to one question. However they interleave, a card is answered once, what it is for is done at most once, and nothing is written for a card that was voided.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore: plain ESM without declarations
import { createIntentRegistry } from '../shared/momoIntents.mjs';
import { add, lines, owner, said, world } from './support/host/notesToolWorld.ts';

async function racing(t: any) {
  const w = await world(t);
  const registry = createIntentRegistry({ running: () => !!w.home.stamp() });
  registry.register('gate', w.home.service('gate').intents);
  const run = registry.intents() as Record<string, (i: any) => Promise<any>>;
  await owner(w, 'Remember that I prefer email over calls');
  await w.home.service('gate').taintFor(w.M).toolResult('outside');
  assert.equal(said(await w.call(w.M, 'momo_notes', add)), 'refused:approval_pending');
  const gate = w.home.service('gate');
  const cards = async () => (await gate.cards('phone:a')) as any[];
  const [card] = (await cards()).filter((c: any) => c.status === 'pending');
  const rejected = (p: Promise<unknown>) =>
    p.then(
      () => false,
      () => true,
    );
  return { w, run, gate, card, cards, rejected };
}
const texts = (w: any) =>
  w.home
    .service('notes')
    .view()
    .flatMap((n: any) => n.lines.filter((l: any) => l.status !== 'let-go').map((l: any) => l.text));

test('two devices allow one card at the same moment: one wins, and the note is written once', async (t) => {
  const { w, gate, card } = await racing(t);
  const [a, b] = await Promise.all([gate.answer(card.id, 'allow', 'phone:a', 'Phone'), gate.answer(card.id, 'allow', 'desktop:b', 'Mac')]);
  assert.deepEqual([a.won, b.won].sort(), [false, true]);
  assert.equal(lines(w), 1);
  assert.deepEqual(texts(w), [add.text]);
});

test('an Allow and a Deny at the same moment: one answer wins, and the note is written only if it was the Allow', async (t) => {
  const { w, gate, card } = await racing(t);
  const [allow, deny] = await Promise.all([
    gate.answer(card.id, 'allow', 'phone:a', 'Phone'),
    gate.answer(card.id, 'deny', 'desktop:b', 'Mac'),
  ]);
  assert.equal([allow.won, deny.won].filter(Boolean).length, 1);
  assert.equal(lines(w), allow.won ? 1 : 0);
});

test('an Allow and an Edit at the same moment, several times over: the old text or the new one can be written, never both, and never an old card beside a new one', async (t) => {
  for (let round = 0; round < 6; round++) {
    const { w, run, gate, card, cards, rejected } = await racing(t);
    const [allow, edited] = await Promise.all([
      gate.answer(card.id, 'allow', 'phone:a', 'Phone').catch(() => ({ won: false })),
      rejected(
        run['approval.edit']({ kind: 'approval.edit', id: card.id, body: 'Prefers phone calls', by: { id: 'desktop:b', name: 'Mac' } }),
      ).then((r) => !r),
    ]);
    // the edit only goes through while the old card still waits, and the old card is claimed before the new one is made
    assert.notEqual(allow.won && edited, true, 'an answered card is not edited');
    const all = await cards();
    const waiting = all.filter((c: any) => c.status === 'pending');
    if (edited) {
      assert.equal(waiting.length, 1);
      assert.equal(lines(w), 0, 'nothing is written until the new card is answered');
      await gate.answer(waiting[0].id, 'allow', 'phone:a', 'Phone');
      assert.deepEqual(texts(w), ['Prefers phone calls']);
    } else {
      assert.equal(waiting.length, 0);
      assert.deepEqual(texts(w), [add.text]);
    }
    assert.equal(lines(w), 1);
  }
});

test('an Allow and an expiry at the same moment: the card is answered or it expired, never both, and what it is for is not done for an expired card', async (t) => {
  const w = await world(t);
  await owner(w, 'Plan my week');
  const ran: string[] = [];
  w.registry.register({
    name: 'momo_gmail_send',
    policy: 'act',
    authorizesItself: true,
    description: 'send',
    schema: { type: 'object', properties: {} },
    handler: () => (ran.push('sent'), 'done'),
  });
  w.home.gate.tools.register({ tool: 'momo_gmail_send', effect: 'send' });
  const gate = w.home.service('gate');
  const raise = () =>
    w.home.gate
      .run({ chatId: w.M, tool: 'momo_gmail_send', args: { to: 'a@example.com' }, origin: 'task' }, () => 'sent')
      .catch((e: any) => e.code);
  assert.equal(await raise(), 'approval_pending');
  const [card] = ((await gate.cards('phone:a')) as any[]).filter((c: any) => c.status === 'pending');
  w.clock.at += 31 * 60_000;
  const [answer] = await Promise.all([gate.answer(card.id, 'allow', 'phone:a', 'Phone'), gate.sweep()]);
  const status = (((await gate.cards('phone:a')) as any[]).find((c: any) => c.id === card.id) as any).status;
  if (answer.won) assert.match(status, /approved|consumed|completed/);
  else assert.equal(status, 'expired');
  assert.deepEqual(ran, [], 'nothing was sent by an answer alone');
});

test('an Allow and a move at the same moment, or the home moving between the Allow and the write: nothing is written', async (t) => {
  const { w, gate, card } = await racing(t);
  const real = w.home.stamp.bind(w.home);
  w.home.stamp = () => {
    const s = real();
    return s && { ...s, leaseEpoch: s.leaseEpoch + 1 };
  };
  w.home.current = () => true;
  await Promise.all([gate.answer(card.id, 'allow', 'phone:a', 'Phone'), gate.cards('phone:a')]);
  assert.equal(lines(w), 0);
});

test('the home moves between the Allow and the write: the write is refused and the card says so', async (t) => {
  const { w, gate, card, cards } = await racing(t);
  w.home.current = () => false;
  await gate.answer(card.id, 'allow', 'phone:a', 'Phone');
  assert.equal(lines(w), 0);
  const ended = (await cards()).find((c: any) => c.id === card.id);
  assert.equal(ended.status, 'failed');
  assert.match(ended.failure.cause, /moved to another machine/);
});

test('two answers to one question at the same moment: one wins and the answer kept is the winner’s', async (t) => {
  const w = await world(t);
  const rows: any[] = [];
  w.home.rows = { put: async (r: any) => void rows.push(r) };
  await owner(w, 'Plan my week');
  await w.call(w.M, 'momo_ask', { title: 'Which calendar?', options: ['Work', 'Home'] });
  const questions = w.home.service('questions');
  const [q] = questions.view();
  const [a, b] = await Promise.all([questions.answer(q.id, 'o1', { id: 'phone:a' }), questions.answer(q.id, 'o2', { id: 'desktop:b' })]);
  assert.deepEqual([a.won, b.won].sort(), [false, true]);
  const winner = a.won ? 'o1' : 'o2';
  assert.equal(questions.view()[0].answer.optionId, winner);
  assert.match(
    said(await w.call(w.M, 'momo_ask', { title: 'Which calendar?', options: ['Work', 'Home'] })),
    new RegExp(`answered "${winner === 'o1' ? 'Work' : 'Home'}"`),
  );
});

test('two edits of one card at the same moment: one makes the new card, the other finds the card already claimed', async (t) => {
  let claimedLate = 0;
  for (let round = 0; round < 6; round++) {
    const { w, run, gate, card, cards, rejected } = await racing(t);
    const edit = (body: string) => run['approval.edit']({ kind: 'approval.edit', id: card.id, body, by: { id: 'phone:a', name: 'Phone' } });
    const [a, b] = await Promise.all([rejected(edit('First words')), rejected(edit('Second words'))]);
    assert.equal([a, b].filter((failed) => !failed).length, 1, 'one edit makes the new card');
    if (a || b) claimedLate++;
    assert.equal((await cards()).filter((c: any) => c.status === 'pending').length, 1, 'one card waits');
    const [fresh] = (await cards()).filter((c: any) => c.status === 'pending');
    await gate.answer(fresh.id, 'allow', 'phone:a', 'Phone');
    assert.equal(lines(w), 1, 'written once');
  }
  assert.equal(claimedLate, 6);
});
