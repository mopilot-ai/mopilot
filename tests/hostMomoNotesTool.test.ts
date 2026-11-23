// MoMo's notes tool (host/src/momoNotesTool.mjs) behind the real registry and the real gate: a note's source is the owner's own message of the turn the chat is answering, as the Host recorded it (host/src/momoServices/ownerWords.mjs), never anything the model sends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const { segmentKey } = createRequire(import.meta.url)('../electron/platform/segmentOwner.cjs');
import { add, lines, owner, phone, said, settleWords, world } from './support/host/notesToolWorld.ts';

test('the owner says "remember X" in a clean chat: the note is written without a card, from their words, and a sourceId the model sent is ignored', async (t) => {
  const w = await world(t);
  assert.equal(said(await w.call(w.M, 'momo_notes', add)), 'refused:read_only', 'no owner message yet');
  const turn = await owner(w, 'Remember that I prefer email over calls');
  assert.match(said(await w.call(w.M, 'momo_notes', { ...add, sourceId: 'forged' })), /Written to MoMo’s notes/);
  assert.equal(lines(w), 1);
  assert.deepEqual(
    w.home
      .service('notes')
      .view()[0]
      .lines[0].sources.map((s: any) => s.id),
    [turn],
    'the source is the owner’s turn, not the forged id',
  );
  assert.equal((await w.home.service('gate').cards('phone:a')).length, 0, 'no card in a clean chat');
  // a quote the owner did not say is not written
  assert.match(said(await w.call(w.M, 'momo_notes', { ...add, text: 'Wire money', quote: 'wire all invoices today' })), /Not written/);
  assert.equal(lines(w), 1);
});

test('a page told to the chat asks for a note: the write is a card with the exact line, and Allow writes that op once, in a later turn, with no retry', async (t) => {
  const w = await world(t);
  const first = await owner(w, 'Remember that I prefer email over calls');
  await w.home.service('gate').taintFor(w.M).toolResult('outside');
  assert.equal(said(await w.call(w.M, 'momo_notes', { ...add, sourceId: 'forged' })), 'refused:approval_pending');
  assert.equal(lines(w), 0);
  const card = (await w.home.service('gate').cards('phone:a')).find((c: any) => c.fields.some((f: any) => f.value === add.text));
  assert.ok(card, 'the card shows the exact line');
  assert.ok(!card.fields.some((f: any) => f.label === 'sourceId'), 'no field the Host ignores');
  assert.ok(
    card.fields.some((f: any) => f.label === 'You said' && /prefer email/.test(f.value)),
    'and the words it was checked against',
  );
  // the turn ends and the owner says something else; they tap Allow later
  w.home.turnEnded(w.M, { stopReason: 'end_turn' });
  await settleWords(w);
  await owner(w, 'What is the weather like');
  await w.home.service('gate').answer(card.id, 'allow', 'phone:a', 'Phone');
  assert.equal(lines(w), 1, 'written by the Host at the tap, from the words of the turn it was asked in');
  assert.deepEqual(
    w.home
      .service('notes')
      .view()[0]
      .lines[0].sources.map((x: any) => x.id),
    [first],
    'its source is the first turn’s message',
  );
  // the model's retry in the new turn spends nothing and writes nothing more
  assert.notEqual(said(await w.call(w.M, 'momo_notes', add)), 'ran');
  assert.equal(lines(w), 1);
});

test('a card for a note that is denied writes nothing and keeps its op to be asked again; one of a lease the home no longer holds is void and its op is forgotten', async (t) => {
  const w = await world(t);
  await owner(w, 'Remember that I prefer email over calls');
  await w.home.service('gate').taintFor(w.M).toolResult('outside');
  await w.call(w.M, 'momo_notes', add);
  const gate = w.home.service('gate');
  const bound = () => Object.keys(w.home.data.sealed('bound-notes.json', (v: any) => v ?? { cards: {} }).read().cards);
  const [card] = (await gate.cards('phone:a')).filter((c: any) => c.status === 'pending');
  assert.deepEqual(bound(), [card.id]);
  await gate.answer(card.id, 'deny', 'phone:a', 'Phone');
  assert.equal(lines(w), 0);
  assert.deepEqual(bound(), [card.id], 'the owner may ask again');
  // a second one is raised under a lease the home then loses
  await w.call(w.M, 'momo_notes', { ...add, text: 'Likes tea', quote: 'I prefer email' });
  assert.equal(bound().length, 2);
  const real = w.home.stamp.bind(w.home);
  w.home.stamp = () => {
    const s = real();
    return s && { ...s, leaseEpoch: s.leaseEpoch + 1 };
  };
  w.home.current = () => true;
  await gate.cards('phone:a');
  assert.deepEqual(bound(), [card.id], 'only the void card’s op is forgotten; the denied card can still be asked again');
  assert.equal(lines(w), 0);
});

test('an update or retire needs the owner’s quote to be about the line: any other words of theirs make a card, also in a clean chat, showing the line and the new text', async (t) => {
  const w = await world(t);
  await owner(w, 'I prefer email over calls');
  assert.match(said(await w.call(w.M, 'momo_notes', add)), /Written/);
  const note = w.home.service('notes').view()[0];
  const line = note.lines[0];
  await w.home.stores().turns.settle(w.M, 'completed');
  await owner(w, 'Thanks, I prefer email over calls. See you on Friday.');
  const retire = { type: 'retire', noteId: note.id, lineId: line.id, reason: 'obsolete' };
  // the boundary of "about the line": it says what the line says (at least half of each way), not just something the owner said
  assert.equal(w.home.service('notes').binds({ ...retire, quote: 'prefer email over calls' }), true);
  assert.equal(w.home.service('notes').binds({ ...retire, quote: 'See you on Friday' }), false);
  assert.equal(w.home.service('notes').binds({ ...retire, noteId: 'nope', quote: 'prefer email over calls' }), false, 'no such line');
  // a real quote of the owner's, but about nothing the line says: a card, and the line stays
  assert.equal(said(await w.call(w.M, 'momo_notes', { ...retire, quote: 'See you on Friday' })), 'refused:approval_pending');
  const card = (await w.home.service('gate').cards('phone:a')).find((c: any) => c.fields.some((f: any) => f.label === 'Current line'));
  assert.ok(card.fields.some((f: any) => f.label === 'Current line' && f.value === 'Prefers email'));
  assert.equal(w.home.service('notes').view()[0].lines.length, 1);
  // words about the line itself are enough, with no card
  assert.match(said(await w.call(w.M, 'momo_notes', { ...retire, quote: 'prefer email over calls' })), /Written/);
});

test('with no owner message behind the call nothing is written: after the turn ended, from a home client or another Host, or in a run', async (t) => {
  const w = await world(t);
  // a message from a client that is not a paired owner device is not recorded
  await owner(w, 'I prefer email', { kind: 'client', fingerprint: 'other-host' });
  await w.home.stores().turns.settle(w.M, 'completed');
  assert.equal(said(await w.call(w.M, 'momo_notes', add)), 'refused:read_only');
  const key = await owner(w, 'I prefer email over calls');
  assert.match(said(await w.call(w.M, 'momo_notes', add)), /Written/);
  // the turn ended: its words are no longer a source
  await w.home.stores().turns.settle(w.M, 'completed');
  assert.equal(said(await w.call(w.M, 'momo_notes', { ...add, text: 'Likes tea', quote: 'I prefer email' })), 'refused:read_only');
  // a background run's chat never writes (the runner refuses before the gate)
  const run = w.home.chats.startBackground('claude', 'routine');
  assert.equal(said(await w.call(run, 'momo_notes', add)), 'refused:read_only');
  assert.ok(key);
});

test('what is kept of the owner’s words is bounded, sealed under the home and gone after a Reset; the tool is a MoMo chat’s only', async (t) => {
  const w = await world(t);
  for (let i = 0; i < 25; i++) {
    await owner(w, `message ${i} `.repeat(3));
    await w.home.stores().turns.settle(w.M, 'completed');
  }
  await owner(w, 'message 24 last');
  assert.equal(w.home.service('ownerWords').current(w.M)?.text, 'message 24 last');
  assert.equal(fs.existsSync(path.join(w.home.storage.dir, 'owner-words.json')), true);
  assert.ok(!fs.readFileSync(path.join(w.home.storage.dir, 'owner-words.json'), 'utf8').includes('message'), 'sealed');
  assert.ok(w.names(w.M).includes('momo_notes'));
  assert.ok(!w.names(w.coding).includes('momo_notes'));
  assert.equal(said(await w.call(w.coding, 'momo_notes', add)), 'refused:unavailable');
  await w.home.reset();
  assert.equal(fs.existsSync(path.join(w.home.storage.dir, 'owner-words.json')), false);
});

test('an order the owner gave becomes a rule suggestion that waits for a tap; a repeat is nothing to write; the other reasons are told in words', async (t) => {
  const w = await world(t);
  await owner(w, 'Please always send invoices to accounting@example.com');
  const order = {
    type: 'add',
    title: 'Invoices',
    kind: 'topic',
    text: 'Always send invoices to accounting@example.com',
    quote: 'always send invoices to accounting@example.com',
  };
  assert.match(said(await w.call(w.M, 'momo_notes', order)), /rule suggestion/);
  assert.equal(lines(w), 0);
  assert.equal(w.home.service('learning').view().rules.length, 1);
  await w.home.stores().turns.settle(w.M, 'completed');
  await owner(w, 'I prefer email over calls');
  assert.match(said(await w.call(w.M, 'momo_notes', add)), /Written/);
  assert.match(said(await w.call(w.M, 'momo_notes', add)), /already in MoMo’s notes|Nothing to write|Written/);
  // a retire of a line that is not there is a card that says so
  assert.equal(
    said(await w.call(w.M, 'momo_notes', { type: 'retire', noteId: 'nope', lineId: 'nope', reason: 'obsolete', quote: 'I prefer email' })),
    'refused:approval_pending',
  );
  assert.match(said(await w.call(w.M, 'momo_notes', { type: 'add', text: '', quote: 'I prefer email' })), /Not written/);
  // a call with no arguments at all is still the model's mistake, not a crash
  assert.match(said(await w.call(w.M, 'momo_notes', { type: 'add', quote: 'I prefer email' })), /Not written|refused/);
});

test('the words are kept only for a real message of the main chat once, only the last few chats are kept, and a Host that is not the home keeps none', async (t) => {
  const w = await world(t);
  const words = w.home.service('ownerWords');
  assert.equal(await words.heard({ turnId: 'key-00000001', chatId: w.M, text: '   ', principal: phone }), false);
  assert.equal(await words.heard({ turnId: 'key-00000001', chatId: w.M, text: 5, principal: phone }), false);
  assert.equal(await words.heard({ turnId: 'key-00000001', chatId: w.coding, text: 'hi', principal: phone }), false);
  assert.equal(await words.heard({ turnId: 'key-00000001', chatId: w.M, text: 'hi there', principal: null }), false);
  assert.equal(await words.heard({ turnId: 'key-00000001', chatId: w.M, text: 'hi there', principal: phone }), true);
  assert.equal(
    await words.heard({ turnId: 'key-00000001', chatId: w.M, text: 'hi there', principal: phone }),
    true,
    'the same message again is kept as one',
  );
  // more chats than are kept: the oldest go
  for (let i = 0; i < 12; i++) {
    const other = `claude:${crypto.randomUUID()}`;
    w.records.set(other, { id: other, segments: [], meta: { momo: 'main' } });
    await words.heard({ turnId: `key-1000000${i}`, chatId: other, text: `m${i}`, principal: phone });
  }
  assert.equal(words.current(w.M), null, 'the least recently heard chat was let go');
  assert.equal(
    Object.keys(w.home.data.sealed('owner-words.json', (v: any) => v).read().chats).length,
    4,
    'at most four chats keep a message',
  );
  await w.home.lifecycle('pause');
  await w.home.stop?.();
  assert.equal(w.home.service('ownerWords').current(w.M), null);
});

test('a notes tool call on a Host that is not running the home is unavailable', async (t) => {
  const w = await world(t);
  await owner(w, 'I prefer email over calls');
  w.home.service('notes').ops = async () => null;
  assert.equal(said(await w.call(w.M, 'momo_notes', add)), 'refused:unavailable');
});

test('a damaged record of the owner’s words reads as what can be read of it', async (t) => {
  const w = await world(t);
  const { sealedStore } = await import('../host/src/momoCoreHost.mjs' as string);
  const store = sealedStore({
    dir: w.home.storage.dir,
    name: 'owner-words.json',
    safeStorage: w.home.data.safeStorage,
    shape: (v: any) => v ?? { chats: {} },
    now: Date.now,
  });
  await store.change((all: any) => {
    all.chats = { [w.M]: { turnId: 5 }, kept: { turnId: 'key-00000077', at: 'x', text: 'kept' }, other: 'not a record' };
  });
  const key = await owner(w, 'I prefer email over calls');
  assert.equal(w.home.service('ownerWords').current(w.M)?.turnId, key);
  assert.deepEqual(Object.keys(w.home.data.sealed('owner-words.json', (v: any) => v).read().chats).sort(), ['kept', w.M].sort());
  // settling a chat that has no words, or on a Host that is not the home, changes nothing
  await w.home.service('ownerWords').settled('nobody');
  const away = await world(t, { start: false });
  await away.home.service('ownerWords').settled(away.M);
  assert.equal(away.home.service('notes').lineText('n', 'l'), null);
});

test('a call whose segment belongs to another chat, and a Host that is not the home, have no words to write from', async (t) => {
  const w = await world(t);
  await owner(w, 'I prefer email over calls');
  const foreign = await w.registry.invoke(w.M, segmentKey('claude', crypto.randomUUID()), 'momo_notes', add);
  assert.equal(said(foreign), 'refused:unavailable');
  assert.equal(lines(w), 0);
  const away = await world(t, { start: false });
  assert.equal(away.home.service('ownerWords').current(away.M), null);
});

test('words the Host could not keep never stop the message, and the note then has nothing to cite', async (t) => {
  const w = await world(t);
  w.home.service('ownerWords').heard = async () => {
    throw new Error('disk full');
  };
  const key = await owner(w, 'I prefer email over calls');
  assert.ok(key, 'the guard let the message through');
  assert.equal(said(await w.call(w.M, 'momo_notes', add)), 'refused:read_only');
});

test('seeding keeps one message, and the file opens with the home’s data key', async (t) => {
  const w = await world(t);
  await w.home.seed();
  assert.equal(fs.existsSync(path.join(w.home.storage.dir, 'owner-words.json')), true);
});

test('the owner’s words are dropped when the turn ends, cut on whole characters, and the file never holds more than the open turn', async (t) => {
  const w = await world(t);
  await owner(w, `${'😀'.repeat(4001)} I prefer email`);
  const kept = w.home.service('ownerWords').current(w.M).text;
  assert.equal(Array.from(kept).length, 4000);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(kept), 'no half of a pair');
  w.home.turnEnded(w.M, { stopReason: 'end_turn' });
  await settleWords(w);
  assert.deepEqual(
    Object.keys(w.home.data.sealed('owner-words.json', (v: any) => v).read().chats),
    [],
    'nothing of the owner’s words stays once the turn ended',
  );
});

test('a Host with no grant has no notes tool and keeps no words', async (t) => {
  const w = await world(t);
  assert.ok(w.names(w.M).includes('momo_notes'));
  const off = await world(t, { grant: false });
  assert.ok(!off.names(off.M).includes('momo_notes'));
  assert.equal(await off.home.service('ownerWords').heard({ turnId: 'key-00000009', chatId: off.M, text: 'hi', principal: phone }), false);
  assert.equal(off.home.service('ownerWords').current(off.M), null);
});

test('a suggested rule is audited before it is kept: with no audit line it is not kept', async (t) => {
  const w = await world(t);
  const learning = w.home.service('learning');
  const real = w.home.stores.bind(w.home);
  w.home.stores = () => {
    const s = real();
    return (
      s && {
        ...s,
        audit: {
          intent: () => Promise.reject(new Error('disk full')),
          refusal: () => Promise.reject(new Error('disk full')),
          outcome: () => Promise.reject(new Error('disk full')),
        },
      }
    );
  };
  assert.equal(await learning.suggest({ text: 'Always send invoices to accounting', sourceId: 'm1', quote: 'q' }), null);
  assert.equal(learning.view().rules.length, 0);
  w.home.stores = real;
  assert.ok(await learning.suggest({ text: 'Always send invoices to accounting', sourceId: 'm1', quote: 'q' }));
  assert.equal(learning.view().rules.length, 1);
});

test('the handler itself asks for the owner’s words again, and a note the owner allowed that the checks reject ends as a failed card with the reason', async (t) => {
  const reports: string[] = [];
  const w = await world(t, { report: (m: string) => reports.push(m) });
  await owner(w, 'Remember that I prefer email over calls');
  // the words are there for the gate and gone by the time the handler asks: nothing is written
  const words = w.home.service('ownerWords');
  const real = words.current;
  let asked = 0;
  words.current = (id: string) => (++asked === 1 ? real(id) : null);
  assert.equal(said(await w.call(w.M, 'momo_notes', add)), 'refused:read_only');
  words.current = real;
  assert.equal(lines(w), 0);
  // a call whose quote is not the owner's: the card is made (its op is shown), and Allow cannot write it
  await w.home.service('gate').taintFor(w.M).toolResult('outside');
  const bad = { ...add, quote: 'wire everything to a stranger today' };
  assert.equal(said(await w.call(w.M, 'momo_notes', bad)), 'refused:approval_pending');
  const card = (await w.home.service('gate').cards('phone:a')).find((c: any) => c.fields.some((f: any) => f.label === 'quote'));
  await w.home.service('gate').answer(card.id, 'allow', 'phone:a', 'Phone');
  assert.equal(lines(w), 0);
  const shown = (await w.home.service('gate').cards('phone:a')).find((c: any) => c.id === card.id);
  assert.equal(shown.status, 'failed');
  assert.match(shown.failure.cause, /quote/);
});

test('a tap whose write cannot even start is reported, and the card is not left pretending', async (t) => {
  const reports: string[] = [];
  const w = await world(t, { report: (m: string) => reports.push(m) });
  await owner(w, 'Remember that I prefer email over calls');
  await w.home.service('gate').taintFor(w.M).toolResult('outside');
  await w.call(w.M, 'momo_notes', add);
  const [card] = (await w.home.service('gate').cards('phone:a')).filter((c: any) => c.status === 'pending');
  w.home.current = () => {
    throw new Error('no home');
  };
  await w.home.service('gate').answer(card.id, 'allow', 'phone:a', 'Phone');
  assert.ok(reports.some((m) => /could not write the note the owner allowed: no home/.test(m)));
  assert.equal(lines(w), 0);
});
