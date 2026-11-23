// The Mac keeps the divider of a switch the Host journaled (#4775): one note per settled switch, beside the turn that settled it, by an id that tells the same note twice; an item it cannot use leaves nothing, and a Host that never says one changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, FakeItems, createRemoteChats, end, fakeHost, start, tick } from './support/host/remoteChatsKit.ts';

function world(withNote = true) {
  const notes: any[][] = [];
  const host = fakeHost();
  const chats = createRemoteChats({
    items: new FakeItems(),
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
    emit: () => undefined,
    ...(withNote ? { note: (chatId: string, note: any) => notes.push([chatId, note]) } : {}),
    now: () => 4242,
    report: () => undefined,
  });
  chats.follow(CHAT);
  const told = async (rev: number, item: any) => {
    host.fire.patch(CHAT, rev, item);
    await tick();
    await chats.settled(CHAT);
  };
  return { chats, host, notes, told };
}

test('A: a journaled switch becomes the chat’s divider, led by its turn, once however often it is told', async () => {
  const w = world();
  await w.chats.settled(CHAT);
  await w.told(1, start('t1'));
  await w.told(2, { t: 'switch', from: 'claude', to: 'codex', text: 'Moved from Claude Code to Codex', at: 5000, turnId: 't1' });
  await w.told(3, end('t1'));
  assert.deepEqual(w.notes, [
    [
      CHAT,
      {
        id: 'switch-t1',
        kind: 'switch',
        text: 'Moved from Claude Code to Codex',
        turnId: 't1',
        turn: Number.MAX_SAFE_INTEGER,
        at: 5000,
        lead: true,
      },
    ],
  ]);
  // the same revision told again (a reconnect) adds nothing, and a long text is cut
  await w.told(2, { t: 'switch', from: 'claude', to: 'codex', text: 'Moved', at: 5000, turnId: 't1' });
  assert.equal(w.notes.length, 1);
  await w.told(4, { t: 'switch', from: 'codex', to: 'claude', text: 'x'.repeat(900), turnId: 't2' });
  assert.equal((w.notes[1][1] as any).text.length, 300);
  assert.equal((w.notes[1][1] as any).at, 4242, 'an item with no time is dated when this Mac heard it');
});

test('W: main keeps the note once, by its id, and the thread draws it first in its turn as the divider it already has', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { laneOf } = require('../electron/host/wiring.cjs');
  const { withChatNotes } = await import('../shared/chatNotes.mjs');
  const kept: any[] = [];
  const told: any[] = [];
  const record = { meta: { notes: [] as any[] } };
  const chats = {
    record: () => record,
    patchMeta: (_id: string, patch: any) => (kept.push(patch), (record.meta.notes = patch.notes), true),
    get: (id: string) => ({ id }),
  };
  const lane = laneOf({ handle: () => undefined }, () => true, { live: { chats }, broadcastAll: (...a: any[]) => told.push(a) });
  const note = {
    id: 'switch-t1',
    kind: 'switch',
    text: 'Moved from Claude Code to Codex',
    turnId: 't1',
    turn: Number.MAX_SAFE_INTEGER,
    at: 5000,
    lead: true,
  };
  lane.note('c1', note);
  lane.note('c1', note);
  assert.equal(kept.length, 1, 'the same id is kept once');
  assert.deepEqual(told, [['chats:changed', { id: 'c1', chat: { id: 'c1' } }]]);
  // a chat main cannot change, and sessions that are not up yet, tell no one
  chats.patchMeta = () => false;
  lane.note('c1', { ...note, id: 'switch-t2' });
  assert.equal(told.length, 1);
  assert.doesNotThrow(() => laneOf({ handle: () => undefined }, () => true, { live: {}, broadcastAll: () => undefined }).note('c1', note));
  // the thread: first in the turn it names, as the statusNote the switch divider draws
  const turns = [
    { id: 'h-t0', items: [{ id: 'a' }] },
    { id: 'h-t1', items: [{ id: 'b' }] },
  ];
  const out = withChatNotes(turns, [note]);
  assert.deepEqual(
    out[1].items.map((i: any) => [i.id, i.type, i.kind]),
    [
      ['switch-t1', 'statusNote', 'switch'],
      ['b', undefined, undefined],
    ],
  );
  assert.equal(out[0].items.length, 1);
});

test('I: a client that does not know the item skips it: it is no event, and it pairs nothing', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { eventOf, otherFamily } = require('../shared/host/fold.mjs');
  const { createStartPairs } = require('../shared/host/turnStartPairs.mjs');
  const item = { t: 'switch', from: 'claude', to: 'codex', text: 'Moved', at: 1, turnId: 't1' };
  assert.equal(eventOf(item), null);
  assert.equal(otherFamily(item), null);
  assert.deepEqual(createStartPairs().take(item, null), []);
});

test('A: a mirror made with nowhere to keep notes takes the item without a word and changes nothing', async () => {
  const w = world(false);
  await w.chats.settled(CHAT);
  await w.told(1, start('t1'));
  await w.told(2, { t: 'switch', from: 'claude', to: 'codex', text: 'Moved from Claude Code to Codex', at: 5000, turnId: 't1' });
  await w.told(3, end('t1'));
  assert.deepEqual(w.notes, []);
});

test('B: an item with no turn or no words leaves no note, and the chat goes on as before', async () => {
  const w = world();
  await w.chats.settled(CHAT);
  await w.told(1, { t: 'switch', text: 'Moved', at: 1 });
  await w.told(2, { t: 'switch', turnId: 't1', text: '', at: 1 });
  await w.told(3, { t: 'switch', turnId: 't1', text: 5, at: 1 });
  await w.told(4, start('t1'));
  await w.told(5, end('t1'));
  assert.deepEqual(w.notes, []);
});
