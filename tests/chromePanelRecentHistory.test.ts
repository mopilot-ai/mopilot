// What a phone opening a chat reads from the Mac (the rows of its snapshot, its cards, the page before a row) is read from the end of the chat's saved history, as far back as it needs: a read of the whole chat is what a runtime with no end read falls back to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup } from './support/controller/fixture.ts';
import { notesNeedWholeHistory } from '../shared/chatNotes.mjs';

const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const { createHistoryReader } = require('../electron/app/chromePanelHistory.cjs');
const GONE = "That chat isn't in MoPilot.";

const row = (id: string, text: string) => ({ id, type: 'agentMessage', text });
/** A turn of `n` assistant rows. */
const turn = (id: string, n = 2) => ({ id, items: Array.from({ length: n }, (_, i) => row(`${id}-${i}`, `${id} row ${i}`)) });
const texts = (rows: any[]) => rows.map((r) => r.text);
/** The rows of a phone's snapshot for a chat: the first `n` from the end. */
const rowsOf = async (panel: any, chatId: string, n: number) => (await panel.o.items(chatId, n)).items;

function wired(t: any) {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  h.chats.records.set('th-1', { id: 'th-1', segments: [{ kind: 'codex', nativeId: 'th-1' }], meta: {} });
  const calls: any = { full: 0, recent: [] as { open: boolean; sizes: boolean[] }[] };
  const live: any = { chats: h.chats, controller: h.c, peerRuntime: {} };
  /** Reads that grow: the first end holds `ends[0]` turns, the next `ends[1]`, and so on, each handed to `enough`. */
  const reads = (ends: any[][], { omitted = true } = {}) => {
    live.peerRuntime.readHistory = Object.assign(
      async () => {
        calls.full++;
        return { turns: ends.at(-1), earlierContentOmitted: false };
      },
      {
        recent: async (_id: string, { open, enough }: { open: boolean; enough: (turns: any[]) => boolean }) => {
          const sizes: boolean[] = [];
          calls.recent.push({ open, sizes });
          for (const turns of ends) {
            const ok = enough(turns);
            sizes.push(ok);
            if (ok) return { turns, earlierContentOmitted: omitted };
          }
          return { turns: ends.at(-1), earlierContentOmitted: omitted };
        },
      },
    );
  };
  const panel = createChromePanel({
    live,
    sources: {},
    home: h.chats.dir,
    projectsFile: projectsFileOf(h.chats.dir),
    prefs: () => ({}),
    usable: async () => true,
    starter: {},
    send: async () => {},
    open: () => {},
  });
  const ask = (method: string, params: any) => new Promise<any>((resolve) => void panel.handle({ id: 1, method, params }, resolve));
  return { h, live, panel, calls, reads, ask };
}

test('a phone’s first rows come from the end of the history, and a larger end is read when the first holds too few', async (t) => {
  const { panel, calls, reads } = wired(t);
  reads([[turn('a')], [turn('a'), turn('b'), turn('c')]]);
  // three rows are wanted: the first end has two, the second six
  const rows = await rowsOf(panel, 'th-1', 3);
  assert.deepEqual(texts(rows), ['b row 1', 'c row 0', 'c row 1']);
  assert.equal(calls.full, 0, 'the whole history is not read');
  assert.deepEqual(calls.recent, [{ open: false, sizes: [false, true] }]);
  // the first end is enough for fewer
  calls.recent.length = 0;
  assert.equal((await rowsOf(panel, 'th-1', 2)).length, 2);
  assert.deepEqual(calls.recent, [{ open: false, sizes: [true] }]);
});

test('a chat of long rows has what a panel read keeps in a small end: the character limit makes the end enough', async (t) => {
  const { panel, calls, reads } = wired(t);
  const long = (id: string) => ({ id, items: Array.from({ length: 30 }, (_, i) => row(`${id}-${i}`, `${id} ${i} ${'x'.repeat(19_000)}`)) });
  // fifty rows are asked for, and the character limit stops the scan at about twenty: the first end is all there is to be had
  reads([[long('a')], [long('a'), long('b')]]);
  const rows = await rowsOf(panel, 'th-1', 50);
  assert.deepEqual(calls.recent, [{ open: false, sizes: [true] }]);
  assert.ok(rows.length > 10 && rows.length < 50, `${rows.length} rows`);
  assert.equal(calls.full, 0);
});

test('rows read while main runs the turn are read open, and the chat’s saved notes are rows too', async (t) => {
  const { panel, calls, reads, live, h } = wired(t);
  h.c.state.patch('th-1', { turn: 'running' });
  live.chats.records.set('th-1', {
    ...live.chats.records.get('th-1'),
    meta: { notes: [{ id: 'n', kind: 'account', text: 'Account changed', turn: 0, turnId: 'a', at: 1 }] },
  });
  reads([[turn('a', 1)]]);
  const rows = await rowsOf(panel, 'th-1', 5);
  assert.equal(calls.recent[0].open, true);
  assert.deepEqual(texts(rows), ['a row 0', 'Account changed']);
});

test('no rows asked for read nothing; a chat that is gone, or goes during the read, is the panel’s missing-chat outcome', async (t) => {
  const { panel, calls, reads, live } = wired(t);
  reads([[turn('a')]]);
  assert.deepEqual(await rowsOf(panel, 'th-1', 0), []);
  assert.equal(calls.recent.length, 0);
  await assert.rejects(rowsOf(panel, 'not-a-chat', 5), { message: GONE });
  // the chat is deleted while the end is being read: gone, whether the read says so or fails
  for (const fail of [false, true]) {
    live.chats.records.set('th-1', { id: 'th-1', segments: [{ kind: 'codex', nativeId: 'th-1' }], meta: {} });
    live.peerRuntime.readHistory = Object.assign(async () => ({ turns: [] }), {
      recent: async () => {
        live.chats.records.delete('th-1');
        live.controller.state.chats.delete('th-1');
        if (fail) throw new Error('chat_unavailable');
        return { turns: [turn('a')] };
      },
    });
    await assert.rejects(rowsOf(panel, 'th-1', 5), { message: GONE }, `reader fails ${fail}`);
  }
});

test('a read failure for a chat that is still there stays its own error', async (t) => {
  const { panel, live } = wired(t);
  live.peerRuntime.readHistory = Object.assign(async () => ({ turns: [] }), {
    recent: async () => {
      throw new Error('Native history offline');
    },
  });
  await assert.rejects(rowsOf(panel, 'th-1', 5), { message: 'Native history offline' });
});

test('a chat that has no record yet has no rows, and MoMo’s main chat may be read by a phone', async (t) => {
  const { panel, live, calls, reads } = wired(t);
  reads([[turn('a')]]);
  live.momo = { mainChat: { usable: (id: string) => id === 'momo-main' } };
  assert.deepEqual(await rowsOf(panel, 'momo-main', 5), []);
  assert.equal(calls.recent.length, 0, 'it has no saved history of its own to read');
  await assert.rejects(rowsOf(panel, 'not-momo', 5), { message: GONE });
});

test('a chat with a note that has no turn id is read whole, since the note goes by an index among all its turns; one with turn ids is read at its end', async (t) => {
  const { panel, calls, reads, live, ask } = wired(t);
  const turns = [turn('a', 3), turn('b', 3)];
  reads([turns.slice(-1), turns]);
  const withNotes = (notes: any[]) =>
    live.chats.records.set('th-1', { id: 'th-1', segments: [{ kind: 'codex', nativeId: 'th-1' }], meta: { notes } });
  withNotes([{ id: 'n1', kind: 'account', text: 'Account changed', turn: 1, turnId: 'b', at: 1 }]);
  await rowsOf(panel, 'th-1', 3);
  assert.deepEqual([calls.full, calls.recent.length], [0, 1], 'the note names its turn');
  withNotes([{ id: 'n2', kind: 'account', text: 'Account changed', turn: 0, turnId: null, at: 1 }]);
  const rows = await rowsOf(panel, 'th-1', 4);
  assert.deepEqual([calls.full, calls.recent.length], [1, 1], 'the note goes by an index: the whole history is read');
  assert.equal(texts(rows).includes('Account changed'), true);
  // the page before a row, too
  const before = rows.at(-1).id;
  calls.full = 0;
  const page = await ask('read', { chatId: 'th-1', before, limit: 2 });
  assert.equal(page.error, undefined);
  assert.deepEqual([calls.full, calls.recent.length], [1, 1]);
});

test('a runtime with no end read answers a phone from the whole history, as before', async (t) => {
  const { panel, live } = wired(t);
  let whole = 0;
  live.peerRuntime.readHistory = async () => (whole++, { turns: [turn('a'), turn('b')], earlierContentOmitted: false });
  const rows = await rowsOf(panel, 'th-1', 3);
  assert.deepEqual(texts(rows), ['a row 1', 'b row 0', 'b row 1']);
  assert.equal(whole, 1);
});

test('cards are read from the last turns only, and an unanswered question in them is offered', async (t) => {
  const { panel, calls, reads } = wired(t);
  const asked = {
    id: 'q',
    type: 'agentMessage',
    text: 'Which one?',
    questions: [{ title: 'Which one?', options: ['A', 'B'] }],
  };
  const turns = Array.from({ length: 7 }, (_, i) => turn(`t${i}`, 1));
  turns[6] = { id: 't6', items: [asked] };
  reads([turns.slice(-2), turns.slice(-3), turns]);
  const cards = await panel.o.cardsOf('th-1');
  assert.equal(calls.full, 0);
  assert.deepEqual(calls.recent, [{ open: false, sizes: [false, true] }], 'three turns are enough');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'A question for you');
  assert.deepEqual(
    cards[0].questions.map((q: any) => q.question),
    ['Which one?'],
  );
  // a chat with no record has no history to read, and so no question to offer
  const before = calls.recent.length;
  assert.deepEqual(await panel.o.cardsOf('not-a-chat'), []);
  assert.equal(calls.recent.length, before);
});

test('a page before a row is read from an end that holds the row and rows before it, with some still earlier', async (t) => {
  const { panel, calls, reads, ask } = wired(t);
  const turns = [turn('a', 3), turn('b', 3), turn('c', 3)];
  const all = [turns, turns.slice(1), turns.slice(2)];
  // the ends from smallest: c, b+c, a+b+c
  reads([all[2], all[1], all[0]], { omitted: true });
  const { result: head } = await ask('read', { chatId: 'th-1' });
  assert.ok(head.rows.length > 0);
  calls.recent.length = 0;
  // the row after the first of turn c: the page before it needs rows that the first end (turn c alone) does not have
  const before = (await rowsOf(panel, 'th-1', 9)).at(-1).id;
  calls.recent.length = 0;
  calls.full = 0;
  const page = await ask('read', { chatId: 'th-1', before, limit: 4 });
  assert.equal(page.error, undefined);
  assert.equal(page.result.rows.length, 4);
  assert.equal(page.result.more, true);
  assert.equal(page.result.omitted, false, 'there is more: nothing is said omitted');
  assert.deepEqual(
    calls.recent,
    [{ open: false, sizes: [false, true] }],
    'the end of turn c alone had too few rows before the row; with turn b it has them',
  );
  assert.equal(calls.full, 0);
  // the row asked for is in no end that was read: the history changed since the phone read it
  const gone = await ask('read', { chatId: 'th-1', before: 'no such row', limit: 4 });
  assert.match(gone.error, /Refresh it to read earlier messages/);
});

test('the history reader: a recent read is not shared, runs its own way when the runtime has one, and fails with the panel’s words past 30 s', async (t) => {
  const live: any = { peerRuntime: {} };
  const history = createHistoryReader(live);
  // no end read: the whole history, through the same limit
  live.peerRuntime.readHistory = async (_id: string, o: any) => ({ turns: [o.open], earlierContentOmitted: false });
  assert.deepEqual((await history.recent('c', { open: true, enough: () => true })).turns, [true]);
  assert.deepEqual((await history.recent('c', { enough: () => true })).turns, [false]);
  live.peerRuntime = {};
  await assert.rejects(history.recent('c', { enough: () => true }), TypeError);
  // an end read, handed the chat, the open flag and the test
  const seen: any[] = [];
  live.peerRuntime = {
    readHistory: Object.assign(async () => ({ turns: ['whole'] }), {
      recent: async (id: string, o: any) => (seen.push([id, o.open, typeof o.enough]), { turns: ['end'], earlierContentOmitted: true }),
    }),
  };
  assert.deepEqual(await history.recent('c', { open: true, enough: () => true }), { turns: ['end'], earlierContentOmitted: true });
  assert.deepEqual(seen, [['c', true, 'function']]);
  // a read that never answers fails once its 30 s are up
  t.mock.timers.enable({ apis: ['setTimeout'] });
  live.peerRuntime = { readHistory: Object.assign(async () => ({ turns: [] }), { recent: () => new Promise(() => undefined) }) };
  const slow = history.recent('c', { enough: () => true });
  t.mock.timers.tick(30_000);
  await assert.rejects(slow, { message: 'Reading this chat took too long. Try again.' });
});

test('notes need the whole history only when one of them has no turn id', () => {
  assert.equal(notesNeedWholeHistory(undefined), false);
  assert.equal(notesNeedWholeHistory(null), false);
  assert.equal(notesNeedWholeHistory([]), false);
  assert.equal(notesNeedWholeHistory([{ turnId: 'a' }, { turnId: 'ct-b' }]), false);
  assert.equal(notesNeedWholeHistory([{ turnId: 'a' }, { turnId: null }]), true);
  assert.equal(notesNeedWholeHistory([{}]), true);
});
