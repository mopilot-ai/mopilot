// A notes card that carries its op (host/src/momoServices/gate.mjs `bound-notes.json`): the line may have changed since the owner was asked, a card whose op was let go cannot stay answerable, what a card shows is cut on whole characters and says so, and a pending card across a move is void on the new home.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import gateService from '../host/src/momoServices/gate.mjs';
import notesService from '../host/src/momoServices/notes.mjs';
import ownerWordsService from '../host/src/momoServices/ownerWords.mjs';
import { moveHome } from '../shared/momoMove.mjs';
import { A, B, host } from './support/host/momoMoveWorld.ts';
import { add, lines, owner, said, world } from './support/host/notesToolWorld.ts';

const bound = (w: any) => Object.keys(w.home.data.sealed('bound-notes.json', (v: any) => v ?? { cards: {} }).read().cards);
const cards = async (w: any) => (await w.home.service('gate').cards('phone:a')) as any[];

test('the line changed after the owner was asked: Allow applies nothing to the new text, and the card is void with the reason', async (t) => {
  const w = await world(t);
  await owner(w, 'I prefer email over calls');
  assert.match(said(await w.call(w.M, 'momo_notes', add)), /Written/);
  const note = w.home.service('notes').view()[0];
  const line = note.lines[0];
  w.home.turnEnded(w.M, { stopReason: 'end_turn' });
  await w.home.service('gate').taintFor(w.M).toolResult('outside');
  await new Promise((r) => setTimeout(r, 100));
  await owner(w, 'I prefer email over calls, and say Dana');
  const retire = { type: 'retire', noteId: note.id, lineId: line.id, reason: 'obsolete', quote: 'I prefer email over calls' };
  assert.equal(said(await w.call(w.M, 'momo_notes', retire)), 'refused:approval_pending');
  const [card] = (await cards(w)).filter((c: any) => c.status === 'pending');
  assert.ok(card.fields.some((f: any) => f.label === 'Current line' && f.value === 'Prefers email'));
  // the owner edits that very line, then taps Allow on the earlier card
  await w.home.service('notes').edit(note.id, line.id, 'Prefers phone calls', 'phone:a');
  await w.home.service('gate').answer(card.id, 'allow', 'phone:a', 'Phone');
  const after = w.home.service('notes').view()[0];
  assert.equal(after.lines.find((l: any) => l.id === line.id).text, 'Prefers phone calls', 'the new text was not retired');
  assert.deepEqual(bound(w), []);
  const shown = (await cards(w)).find((c: any) => c.id === card.id);
  assert.match(shown.status, /^(void|expired)$/);
  assert.deepEqual(
    await w.home.service('gate').answer(card.id, 'allow', 'phone:a'),
    { won: false, status: 'expired' },
    'it cannot be answered again',
  );
});

test('no more than ten things from one chat and fifty in all wait for the owner: more is refused to the model, in words, and a genuine card is never pushed out', async (t) => {
  const w = await world(t);
  await owner(w, 'I prefer email over calls');
  await w.home.service('gate').taintFor(w.M).toolResult('outside');
  for (let i = 0; i < 10; i++)
    assert.equal(said(await w.call(w.M, 'momo_notes', { ...add, text: `Prefers email ${i}` })), 'refused:approval_pending');
  assert.equal(said(await w.call(w.M, 'momo_notes', { ...add, text: 'Prefers email 10' })), 'refused:invalid');
  const waiting = ((await cards(w)) as any[]).filter((c: any) => c.status === 'pending');
  assert.equal(waiting.length, 10, 'the ten genuine cards all still wait');
  assert.equal(bound(w).length, 10);
  // a card the owner answers frees a place
  await w.home.service('gate').answer(waiting[0].id, 'deny', 'phone:a', 'Phone');
  assert.equal(said(await w.call(w.M, 'momo_notes', { ...add, text: 'Prefers email 11' })), 'refused:approval_pending');
  // fifty in all, from other chats
  for (let i = 0; i < 40; i++)
    await w.home.gate
      .run({ chatId: `claude:other-${i}`, tool: 'gmail.send', args: { to: `a${i}@example.com` }, origin: 'chat' }, () => 1)
      .catch(() => undefined);
  const code = await w.home.gate
    .run({ chatId: 'claude:another', tool: 'gmail.send', args: { to: 'z@example.com' }, origin: 'chat' }, () => 1)
    .catch((e: any) => `${e.code}:${e.message}`);
  assert.match(code, /^invalid:50 things are already waiting/);
  assert.equal(lines(w), 0, 'nothing was written');
});

test('what a card shows of the line and of the owner’s words is cut on whole characters and says it was cut', async (t) => {
  const w = await world(t);
  const long = `${'😀'.repeat(310)} I prefer email`;
  await owner(w, long);
  await w.home.service('gate').taintFor(w.M).toolResult('outside');
  assert.equal(said(await w.call(w.M, 'momo_notes', add)), 'refused:approval_pending');
  const [card] = await cards(w);
  const field = card.fields.find((f: any) => f.label === 'You said').value as string;
  assert.match(field, / … \(\d+ more characters not shown\)$/);
  assert.equal(Array.from(field.split(' … ')[0]).length, 300);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(field), 'no half of a pair');
});

test('a pending notes card across a move is void on the new home and its op is forgotten there, and the file travelled with the home', async (t) => {
  const a = await host(t, A);
  const b = await host(t, B);
  for (const h of [a, b]) {
    h.home.chats = { isMain: () => true, isMomoChat: () => true, main: () => ({ chatId: 'momo-chat' }) } as any;
    const deps = { home: h.home, now: () => Date.now() };
    gateService(deps);
    notesService(deps);
    ownerWordsService(deps);
  }
  await a.home.start(A);
  await a.home.stores().turns.accept({ turnId: 'key-00000001', chatId: 'momo-chat', deviceId: 'phone', leaseEpoch: 1 });
  await a.home
    .service('ownerWords')
    .heard({ turnId: 'key-00000001', chatId: 'momo-chat', text: 'I prefer email over calls', principal: { kind: 'phone' } });
  await a.home.gate.taint.mark('momo-chat');
  await assert.rejects(
    a.home.gate.run({ chatId: 'momo-chat', tool: 'momo_notes', args: add, origin: 'chat' }, () => 1),
    (e: any) => e.code === 'approval_pending',
  );
  assert.equal(bound(a).length, 1);
  const moved = await moveHome({ moveId: 'move-0001', from: a.side, to: b.side, target: B, fromName: A.name });
  assert.equal(moved.ok, true);
  assert.equal(bound(b).length, 1, 'the file moved with the home');
  const onB = (await b.home.service('gate').cards('phone:a')) as any[];
  assert.match(onB[0].status, /^(void|expired)$/, 'the card of the old lease is void on the new home');
  assert.deepEqual(bound(b), []);
  assert.equal((await b.home.service('notes').view()).length, 0, 'nothing was written');
});
