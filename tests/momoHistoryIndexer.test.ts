// Keeping MoMo's index of its past chats up to date (electron/momo/historyIndexer.cjs and electron/app/momoHistory.cjs, #2999 P1): one chunk per question and answer from the shared peer transcript (any harness), the <momo-context> block a turn carried left out, only new turns added, a second ask while one runs not lost, coding chats and MoMo-off never read; main indexes a MoMo chat's finished turn, takes a deleted chat out, backfills every MoMo chat later in the background, and Reset empties it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/computerHistory.ts';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createHistoryIndexer, chunksOf, typed } = require('../electron/momo/historyIndexer.cjs');
const { HistoryIndex } = require('../electron/momo/historyIndex.cjs');
const { openMomoHistory, kindOfMeta, BACKFILL_DELAY_MS } = require('../electron/app/momoHistory.cjs');
const { resetMomoStores } = require('../electron/momo/stores.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momo-history-')), 'history');
const user = (text: string) => ({
  type: 'userMessage',
  content: [
    { type: 'text', text },
    { type: 'image', url: 'x' },
  ],
});
const agent = (text: string) => ({ type: 'agentMessage', text });
const turn = (id: string, items: any[], itemTimes: any = {}) => ({ id, items, itemTimes });

test('a turn is what the user typed and what MoMo answered: the memory block left out, tool calls and empty turns skipped', () => {
  const turns = [
    turn(
      'a',
      [
        user('<momo-context>\nMoMo’s memory: likes tea\n</momo-context>\nWhere is my Kyoto trip?'),
        { type: 'commandExecution', command: 'ls' },
        agent('In May.'),
        agent('Want a reminder?'),
      ],
      {
        x: { start: 500 },
        y: 300,
        z: { start: 0 },
      },
    ),
    turn('b', [{ type: 'reasoning', text: 'hm' }]),
    turn('c', [user('[REDACTED:momo-context] plain question')]),
    { items: [agent('a turn with no id')] },
    null,
  ];
  assert.deepEqual(chunksOf(turns, { chatId: 'm', harness: 'codex', kind: 'main', now: 9 }), [
    {
      chatId: 'm',
      turnId: 'a',
      at: 300,
      harness: 'codex',
      kind: 'main',
      user: 'Where is my Kyoto trip?',
      assistant: 'In May.\nWant a reminder?',
    },
    { chatId: 'm', turnId: 'c', at: 9, harness: 'codex', kind: 'main', user: 'plain question', assistant: '' },
    { chatId: 'm', turnId: 't3', at: 9, harness: 'codex', kind: 'main', user: '', assistant: 'a turn with no id' },
  ]);
  assert.deepEqual(chunksOf(undefined, { chatId: 'm', harness: '', kind: 'main', now: 1 }), []);
  assert.deepEqual(chunksOf([{ id: 'n' }], { chatId: 'm', harness: '', kind: 'main', now: 1 }), []);
  // a user message whose content isn't a list of parts counts as no text
  assert.deepEqual(
    chunksOf([turn('d', [{ type: 'userMessage', content: 'raw' }, agent('reply')])], {
      chatId: 'm',
      harness: '',
      kind: 'main',
      now: 1,
    }).map((c: any) => [c.user, c.assistant]),
    [['', 'reply']],
  );
  assert.equal(typed('<momo-context>\na\n</momo-context>\nhello'), 'hello');
  assert.equal(typed(null as any), '', 'no text, no words');
  // text the user typed that only looks like the block is theirs
  assert.equal(typed('<momo-context>a</momo-context>hello'), '<momo-context>a</momo-context>hello');
});

/** An indexer over a real index, with transcripts a test sets per chat. */
function rig(o: { allowed?: () => boolean; kinds?: Record<string, string | null> } = {}) {
  const index = new HistoryIndex({ dir: tmp(), safeStorage: fakeSafe(), saveMs: 60_000 });
  const transcripts = new Map<string, any>();
  const reads: string[] = [];
  const kinds: Record<string, string | null> = o.kinds ?? { m: 'main', r: 'routine' };
  const indexer = createHistoryIndexer({
    index,
    readHistory: async (id: string) => {
      reads.push(id);
      const t = transcripts.get(id);
      return typeof t === 'function' ? t() : t;
    },
    kindOf: (id: string) => kinds[id] ?? null,
    harnessOf: (id: string) => (id === 'm' ? 'claude' : undefined),
    chatIds: () => Object.keys(kinds),
    allowed: o.allowed ?? (() => true),
    now: () => 42,
  });
  return { index, indexer, transcripts, reads, kinds };
}

test('only new turns are added; a coding chat and MoMo off are never read; a transcript that is gone adds nothing', async () => {
  const allowed = { on: true };
  const r = rig({ allowed: () => allowed.on });
  r.transcripts.set('m', { turns: [turn('1', [user('Kyoto in May'), agent('ok')])] });
  assert.equal(await r.indexer.queue('m'), 1);
  r.transcripts.set('m', { turns: [turn('1', [user('Kyoto in May'), agent('ok')]), turn('2', [user('Osaka too'), agent('ok')])] });
  assert.equal(await r.indexer.queue('m'), 1, 'only the new turn');
  assert.deepEqual(
    r.index.search('Kyoto').map((c: any) => [c.chatId, c.harness, c.kind]),
    [['m', 'claude', 'main']],
  );
  r.transcripts.set('r', { turns: [turn('9', [agent('routine said Kyoto')])] });
  await r.indexer.queue('r');
  assert.equal(r.index.search('routine')[0].harness, '', 'a chat with no harness now');
  assert.equal(await r.indexer.queue('coding'), 0);
  assert.equal(r.reads.includes('coding'), false, 'a coding chat is never read');
  r.transcripts.set('m', null);
  assert.equal(await r.indexer.queue('m'), 0);
  allowed.on = false;
  assert.equal(await r.indexer.queue('m'), 0);
  assert.equal(r.reads.filter((x) => x === 'm').length, 3, 'not read while MoMo is off');
});

test('MoMo going off, or the chat stopping being MoMo’s, while the transcript is read adds nothing; an unusable index reads nothing', async () => {
  const allowed = { on: true };
  const r = rig({ allowed: () => allowed.on });
  const gate = deferred<any>();
  r.transcripts.set('m', () => gate.promise);
  const running = r.indexer.queue('m');
  allowed.on = false;
  gate.resolve({ turns: [turn('1', [user('Kyoto')])] });
  assert.equal(await running, 0);
  allowed.on = true;
  const gate2 = deferred<any>();
  r.transcripts.set('m', () => gate2.promise);
  const running2 = r.indexer.queue('m');
  r.kinds.m = null;
  gate2.resolve({ turns: [turn('1', [user('Kyoto')])] });
  assert.equal(await running2, 0);
  assert.equal(r.index.count(), 0);

  const off = rig();
  off.index.available = () => false;
  assert.equal(await off.indexer.queue('m'), 0);
  assert.deepEqual(off.reads, []);
});

test('a second ask while one runs is not lost: it runs once more after; a failure is noted, not thrown', async () => {
  const r = rig();
  const gate = deferred<any>();
  let calls = 0;
  r.transcripts.set('m', () => (++calls === 1 ? gate.promise : { turns: [turn('1', [user('Kyoto')]), turn('2', [user('Osaka')])] }));
  const first = r.indexer.queue('m');
  assert.equal(await r.indexer.queue('m'), 0, 'joins the run already going');
  gate.resolve({ turns: [turn('1', [user('Kyoto')])] });
  assert.equal(await first, 2, 'the turn that ended meanwhile is read in the same run');
  assert.equal(calls, 2);

  clearIgnored();
  r.transcripts.set('m', () => Promise.reject(new Error('transcript gone')));
  assert.equal(await r.indexer.queue('m'), 0);
  assert.ok(recentIgnored().some((e: any) => e.message === 'transcript gone'));
});

test('the backfill reads every MoMo chat once, one after another', async () => {
  const r = rig();
  r.transcripts.set('m', { turns: [turn('1', [user('Kyoto')])] });
  r.transcripts.set('r', { turns: [turn('1', [user('briefing')])] });
  assert.equal(await r.indexer.backfill(), 2);
  assert.deepEqual(r.reads, ['m', 'r']);
});

test('which MoMo chat a chat is, by its meta', () => {
  assert.equal(kindOfMeta({ momo: 'main' }), 'main');
  assert.equal(kindOfMeta({ momo: 'previous' }), 'previous');
  assert.equal(kindOfMeta({ momo: 'routine' }), 'routine');
  assert.equal(kindOfMeta({ momo: 'anything else' }), 'main');
  assert.equal(kindOfMeta({ momo: '' }), null);
  assert.equal(kindOfMeta({}), null);
  assert.equal(kindOfMeta(null), null);
});

/** main's services as openMomoHistory sees them: chats by meta, the controller's and deletion's hooks, the peer runtime. */
function app(o: { peer?: boolean; allowed?: boolean } = {}) {
  const records = new Map<string, any>([
    ['m', { meta: { momo: 'main' } }],
    ['code', { meta: {} }],
  ]);
  const live: any = { chats: { records }, controller: {}, chatDeletion: {} };
  const reads: string[] = [];
  if (o.peer !== false)
    live.peerRuntime = {
      readHistory: async (id: string) => {
        reads.push(id);
        return { turns: [turn('1', [user(`said in ${id}`), agent('ok')])] };
      },
    };
  const h = openMomoHistory({
    dir: path.dirname(tmp()),
    safeStorage: fakeSafe(),
    live,
    chatIds: () => ['m'],
    allowed: () => o.allowed !== false,
    harnessOf: () => 'codex',
  });
  return { h, live, reads, records };
}

test('main indexes a MoMo chat’s finished turn on any harness, never a coding chat’s; a deleted chat is taken out; Reset empties it', async () => {
  const a = app();
  a.live.controller.onFinished({ chatId: 'code' });
  a.live.controller.onFinished({ chatId: 'm' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.reads, ['m']);
  assert.deepEqual(
    a.h.index.search('said').map((c: any) => [c.chatId, c.harness]),
    [['m', 'codex']],
  );
  a.live.chatDeletion.onDeleted({ chatId: 'm' });
  assert.deepEqual(a.h.index.search('said'), []);
  a.h.index.add([{ chatId: 'm', turnId: 'x', at: 1, harness: 'codex', kind: 'main', user: 'Kyoto', assistant: '' }]);
  const done = await resetMomoStores();
  assert.ok(done.reset.some((s: any) => s.id === 'history'));
  assert.deepEqual(a.h.index.search('Kyoto'), []);
});

test('the peer runtime not made yet reads nothing; the backfill waits, and never runs while MoMo is off', async () => {
  const early = app({ peer: false });
  assert.equal(await early.h.indexer.queue('m'), 0);
  const a = app();
  a.h.start(5);
  assert.deepEqual(a.reads, [], 'not at once');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(a.reads, ['m']);
  const off = app({ allowed: false });
  off.h.start(1);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(off.reads, []);
  assert.equal(BACKFILL_DELAY_MS, 30_000);
  // a backfill that fails is noted
  clearIgnored();
  const bad = app();
  bad.h.indexer.backfill = () => Promise.reject(new Error('disk full'));
  bad.h.start(1);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(recentIgnored().some((e: any) => e.message === 'disk full'));
});

test('main without the controller or deletion hooks still makes the index', () => {
  const h = openMomoHistory({
    dir: path.dirname(tmp()),
    safeStorage: fakeSafe(),
    live: { chats: { records: new Map() } },
    chatIds: () => [],
    allowed: () => true,
    harnessOf: () => undefined,
  });
  assert.equal(h.index.available(), true);
});
