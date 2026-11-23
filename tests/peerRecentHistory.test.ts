// The recent end of a chat's history for a reader that wants only its last rows (a phone opening a chat): Claude reads a larger end of the transcript until the turns in hand are enough, Codex reads older pages only until they are, and a chat that switched harness is read whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPeerNativeReader, claudePeerSource } = require('../electron/session/peerNativeHistory.cjs');
const { readPeerRecentTurns, peerHistoryReader } = require('../electron/session/peerTranscript.cjs');

const MB = 1024 * 1024;
const turn = (id: string, text?: string) => ({ id, items: text ? [{ id: `m-${id}:t7`, type: 'agentMessage', text }] : [] });
const ids = (turns: any[]) => turns.map((t) => t.id);
const SEG = { kind: 'claude', nativeId: 'n' };

/** A native reader whose Claude end is the given reads in order (by window), counting what was asked of it. */
function claudeReader(ends: Record<number, { turns: any[]; whole?: boolean; dangling?: boolean }>) {
  const asked: number[] = [];
  const all = { calls: 0 };
  const reader = createPeerNativeReader({
    claudeTurns: async () => (all.calls++, [turn('all-1', 'x'), turn('all-2', 'y')]),
    claudeRecent: async (_id: string, _cwd: string, { bytes }: { bytes: number }) => {
      asked.push(bytes / MB);
      return { whole: false, dangling: false, ...ends[bytes] };
    },
    acpTurns: async () => ({ turns: [turn('acp-1')] }),
    codexTurns: async () => ({ data: [] }),
  });
  return { reader, asked, all };
}
/** Enough once there are this many turns. */
const atLeast = (n: number) => (turns: any[]) => turns.length >= n;

test('a window that holds too little is read again larger, and its first turn, which lost its start, is left out', async () => {
  const { reader, asked } = claudeReader({
    [1 * MB]: { turns: [turn('a'), turn('b'), turn('c')] },
    [4 * MB]: { turns: [turn('a'), turn('b'), turn('c'), turn('d', 'text'), turn('e')] },
  });
  const read = await reader.recent(SEG, undefined, { open: false, enough: atLeast(4) });
  assert.deepEqual(asked, [1, 4]);
  assert.deepEqual(ids(read.turns), ['b', 'c', 'd', 'e']);
  assert.equal(read.truncated, true, 'earlier turns were not read');
  // text is numbered by its own message, so the id of a row does not depend on the window
  assert.equal(read.turns[2].items[0].id, 'm-d:t0');
});

test('the first window that holds enough is the read: no larger one is asked for', async () => {
  const { reader, asked } = claudeReader({ [1 * MB]: { turns: [turn('a'), turn('b'), turn('c'), turn('d')] } });
  const read = await reader.recent(SEG, undefined, { enough: atLeast(3) });
  assert.deepEqual(asked, [1]);
  assert.deepEqual(ids(read.turns), ['b', 'c', 'd']);
});

test('a read that is the whole chat is returned whole: nothing is left out, and nothing is truncated', async () => {
  const { reader, asked } = claudeReader({ [1 * MB]: { whole: true, turns: [turn('a'), turn('b')] } });
  const read = await reader.recent(SEG, undefined, { enough: atLeast(99) });
  assert.deepEqual(asked, [1]);
  assert.deepEqual(ids(read.turns), ['a', 'b']);
  assert.equal(read.truncated, false);
});

test("a window that holds a background task's notification without its launch is not taken, however many turns it holds", async () => {
  const { reader, asked } = claudeReader({
    [1 * MB]: { dangling: true, turns: [turn('a'), turn('b'), turn('c'), turn('d')] },
    [4 * MB]: { turns: [turn('a'), turn('b'), turn('c'), turn('d')] },
  });
  const read = await reader.recent(SEG, undefined, { enough: atLeast(1) });
  assert.deepEqual(asked, [1, 4]);
  assert.deepEqual(ids(read.turns), ['b', 'c', 'd']);
});

test('a launch that stays out of every cheap window is not worth the whole history: the first window with enough rows is taken, as far as 16 MB', async () => {
  const { reader, asked, all } = claudeReader({
    [1 * MB]: { turns: [turn('a'), turn('b')] },
    [4 * MB]: { dangling: true, turns: [turn('a'), turn('b'), turn('c'), turn('d')] },
    [16 * MB]: { dangling: true, turns: [turn('a'), turn('b'), turn('c'), turn('d'), turn('e'), turn('f')] },
  });
  const read = await reader.recent(SEG, undefined, { enough: atLeast(3) });
  assert.deepEqual(
    asked,
    [1, 4, 16],
    'the window that holds enough was not taken at 4 MB, and 16 MB is the last that is read for the launch',
  );
  assert.deepEqual(ids(read.turns), ['b', 'c', 'd'], 'the smaller of the two windows with enough rows');
  assert.equal(read.truncated, true);
  assert.equal(all.calls, 0);
  // a small window with enough rows and a lost launch is kept while larger ones are tried, and taken when they give no better
  const kept = claudeReader({
    [1 * MB]: { dangling: true, turns: [turn('a'), turn('b'), turn('c'), turn('d')] },
    [4 * MB]: { turns: [turn('a'), turn('b')] },
    [16 * MB]: { turns: [turn('a'), turn('b')] },
    [64 * MB]: { turns: [turn('a'), turn('b'), turn('c'), turn('d'), turn('e')] },
  });
  assert.deepEqual(ids((await kept.reader.recent(SEG, undefined, { enough: atLeast(3) })).turns), ['b', 'c', 'd']);
  assert.deepEqual(kept.asked, [1, 4, 16], '64 MB is not read for a launch');
  // enough only from 64 MB on, and a lost launch there: that window is taken, not the whole history
  const far = claudeReader({
    [1 * MB]: { turns: [turn('a'), turn('b')] },
    [4 * MB]: { turns: [turn('a'), turn('b')] },
    [16 * MB]: { turns: [turn('a'), turn('b')] },
    [64 * MB]: { dangling: true, turns: [turn('a'), turn('b'), turn('c'), turn('d')] },
  });
  assert.deepEqual(ids((await far.reader.recent(SEG, undefined, { enough: atLeast(3) })).turns), ['b', 'c', 'd']);
  assert.equal(far.all.calls, 0);
});

test('a window with a compaction and too few rows goes to the whole read: the rows are in what the compaction folded away', async () => {
  const { reader, asked, all } = claudeReader({
    [1 * MB]: { compacted: true, turns: [turn('a'), turn('b')] },
    [4 * MB]: { turns: [turn('a'), turn('b'), turn('c'), turn('d')] },
  } as any);
  const read = await reader.recent(SEG, undefined, { enough: atLeast(3) });
  assert.deepEqual(asked, [1], 'a larger window would hold no more of it');
  assert.equal(all.calls, 1);
  assert.deepEqual(ids(read.turns), ['all-1', 'all-2']);
  // enough rows after the compaction: the window is the read
  const enough = claudeReader({ [1 * MB]: { compacted: true, turns: [turn('a'), turn('b'), turn('c'), turn('d')] } } as any);
  assert.deepEqual(ids((await enough.reader.recent(SEG, undefined, { enough: atLeast(3) })).turns), ['b', 'c', 'd']);
  assert.equal(enough.all.calls, 0);
});

test('a window with a single turn has nothing left once its partial first turn is out, and a larger one is read', async () => {
  const { reader, asked } = claudeReader({ [1 * MB]: { turns: [turn('a')] }, [4 * MB]: { turns: [turn('a'), turn('b')] } });
  const read = await reader.recent(SEG, undefined, { enough: () => true });
  assert.deepEqual(asked, [1, 4]);
  assert.deepEqual(ids(read.turns), ['b']);
});

test('a window that lies wholly inside one turn, from 16 MB on, is that last huge turn: its end is the read, not the whole history (#4097)', async () => {
  const { reader, asked, all } = claudeReader({
    [1 * MB]: { turns: [turn('a')] },
    [4 * MB]: { turns: [turn('a')] },
    [16 * MB]: { turns: [turn('a', 'tail')] },
  });
  const read = await reader.recent(SEG, undefined, { enough: () => false });
  assert.deepEqual(asked, [1, 4, 16], 'a smaller window may still reach the turn start; at 16 MB none would hold more than this turn');
  assert.equal(all.calls, 0);
  assert.deepEqual(ids(read.turns), ['a']);
  assert.equal(read.truncated, true);
  assert.equal(read.turns[0].items[0].id, 'm-a:t0');
});

test('when no window holds enough the whole history is read, as before, numbered as a window is', async () => {
  const { reader, asked, all } = claudeReader({
    [1 * MB]: { turns: [turn('a'), turn('b')] },
    [4 * MB]: { turns: [turn('a'), turn('b')] },
    [16 * MB]: { turns: [turn('a'), turn('b')] },
    [64 * MB]: { turns: [turn('a'), turn('b')] },
  });
  const read = await reader.recent(SEG, undefined, { enough: () => false });
  assert.deepEqual(asked, [1, 4, 16, 64]);
  assert.equal(all.calls, 1);
  assert.deepEqual(ids(read.turns), ['all-1', 'all-2']);
  assert.equal(read.truncated, false);
  assert.equal(read.turns[0].items[0].id, 'm-all-1:t0');
});

test('a Claude source with no way to read an end reads the whole history; an aborted read, and a harness it does not know, fail', async () => {
  const none = createPeerNativeReader({
    claudeTurns: async () => [turn('whole')],
    acpTurns: async () => ({ turns: [] }),
    codexTurns: async () => ({ data: [] }),
  });
  assert.deepEqual(ids((await none.recent(SEG, undefined, { enough: () => true })).turns), ['whole']);
  const stopped = new AbortController();
  stopped.abort();
  const { reader } = claudeReader({});
  await assert.rejects(reader.recent(SEG, stopped.signal, { enough: () => true }), /aborted/);
  await assert.rejects(reader.recent({ kind: 'nothing', nativeId: 'n' }, undefined, { enough: () => true }), /unsupported_history_adapter/);
  // the window loop checks the signal between windows
  const between = new AbortController();
  const slow = createPeerNativeReader({
    claudeTurns: async () => [],
    claudeRecent: async () => (between.abort(), { turns: [turn('a')], whole: false }),
    acpTurns: async () => ({ turns: [] }),
    codexTurns: async () => ({ data: [] }),
  });
  await assert.rejects(slow.recent(SEG, between.signal, { enough: () => false }), /aborted/);
});

test('the Claude source asks the harness for the end with the chat, folder, open flag and window', async () => {
  const asked: any[] = [];
  const source = claudePeerSource({
    allTurns: async () => [],
    recentTurns: async (id: string, o: any) => (asked.push([id, o]), { turns: [], whole: true, dangling: false }),
    replies: async () => [],
  });
  await source.claudeRecent('session', '/work', { open: true, bytes: MB });
  assert.deepEqual(asked, [['session', { chatId: 'session', cwd: '/work', open: true, bytes: MB }]]);
});

test('a harness with no end read gives the Claude source none, so a peer reads its whole history', async () => {
  const source = claudePeerSource({ allTurns: async () => [turn('whole')], replies: async () => [] });
  assert.equal('claudeRecent' in source, false);
  const reader = createPeerNativeReader({ ...source, acpTurns: async () => ({ turns: [] }), codexTurns: async () => ({ data: [] }) });
  assert.deepEqual(ids((await reader.recent(SEG, undefined, { enough: () => true })).turns), ['whole']);
});

test('Codex reads the newest page, and older pages only until the turns in hand are enough', async () => {
  const pages = new Map<string | null, any>([
    [
      null,
      {
        data: [
          { id: 'p1-b', status: 'completed', items: [] },
          { id: 'p1-a', status: 'completed', items: [] },
        ],
        nextCursor: 'c1',
      },
    ],
    [
      'c1',
      {
        data: [
          { id: 'p2-b', status: 'completed', items: [] },
          { id: 'p2-a', status: 'completed', items: [] },
        ],
        nextCursor: 'c2',
      },
    ],
    ['c2', { data: [{ id: 'p3-a', status: 'completed', items: [] }] }],
  ]);
  const cursors: (string | null)[] = [];
  const reader = createPeerNativeReader({
    claudeTurns: async () => [],
    acpTurns: async () => ({ turns: [] }),
    codexTurns: async (_id: string, o: any) => (cursors.push(o.cursor), pages.get(o.cursor)),
  });
  const codex = { kind: 'codex', nativeId: 'n' };
  const one = await reader.recent(codex, undefined, { enough: atLeast(2) });
  assert.deepEqual(cursors, [null], 'the first page was enough');
  assert.deepEqual(ids(one.turns), ['p1-a', 'p1-b']);
  assert.equal(one.truncated, true);
  cursors.length = 0;
  const two = await reader.recent(codex, undefined, { enough: atLeast(3) });
  assert.deepEqual(cursors, [null, 'c1']);
  assert.deepEqual(ids(two.turns), ['p2-a', 'p2-b', 'p1-a', 'p1-b']);
  cursors.length = 0;
  const all = await reader.recent(codex, undefined, { enough: () => false });
  assert.deepEqual(cursors, [null, 'c1', 'c2'], 'pages run out: the whole history');
  assert.equal(all.turns.length, 5);
  assert.equal(all.truncated, false);
});

test('Codex: a page with no turns ends the read', async () => {
  const reader = createPeerNativeReader({
    claudeTurns: async () => [],
    acpTurns: async () => ({ turns: [] }),
    codexTurns: async () => ({}),
  });
  assert.deepEqual(await reader.recent({ kind: 'codex', nativeId: 'n' }, undefined, { enough: () => false }), {
    turns: [],
    truncated: false,
  });
});

test('Codex: a page that fails, a cursor that repeats, or an aborted read fall back to the whole read as before', async () => {
  const rollout = { turns: [{ id: 'rollout-1', status: 'completed', items: [] }] };
  const down = createPeerNativeReader({
    claudeTurns: async () => [],
    acpTurns: async () => ({ turns: [] }),
    codexTurns: async () => {
      throw new Error('app-server is down');
    },
    codexRollout: async () => rollout,
  });
  const codex = { kind: 'codex', nativeId: 'n' };
  assert.deepEqual(
    ids((await down.recent(codex, undefined, { enough: () => false })).turns),
    ['rollout-1'],
    "the thread's rollout file has the turns",
  );
  const loop = createPeerNativeReader({
    claudeTurns: async () => [],
    acpTurns: async () => ({ turns: [] }),
    codexTurns: async () => ({ data: [{ id: 'x', status: 'completed', items: [] }], nextCursor: 'same' }),
  });
  assert.equal((await loop.recent(codex, undefined, { enough: () => false })).truncated, true, 'a cursor that comes round ends it');
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(down.recent(codex, stopped.signal, { enough: () => false }), /aborted/);
  const midway = new AbortController();
  const aborting = createPeerNativeReader({
    claudeTurns: async () => [],
    acpTurns: async () => ({ turns: [] }),
    codexTurns: async () => (midway.abort(), { data: [], nextCursor: 'more' }),
  });
  await assert.rejects(aborting.recent(codex, midway.signal, { enough: () => false }), /aborted/);
});

test('ACP has no end to read: its whole history, with the turn main runs open', async () => {
  const seen: any[] = [];
  const reader = createPeerNativeReader({
    claudeTurns: async () => [],
    acpTurns: async (_key: string, _thread: string, o: any) => (seen.push(o.live), { turns: [turn('acp-1')] }),
    codexTurns: async () => ({ data: [] }),
  });
  const read = await reader.recent({ kind: 'acp:test', nativeId: 'n' }, undefined, { open: true, enough: () => false });
  assert.deepEqual(ids(read.turns), ['acp-1']);
  assert.deepEqual(seen, [true]);
});

const claudeRecord = { segments: [{ kind: 'claude', nativeId: 'n' }] };

test('a chat with one segment is read at its end, and says that earlier turns were left out', async () => {
  const { reader, asked } = claudeReader({ [1 * MB]: { turns: [turn('a'), turn('b'), turn('c')] } });
  const read = await readPeerRecentTurns(claudeRecord, reader, { open: true, enough: atLeast(2) });
  assert.deepEqual(asked, [1]);
  assert.deepEqual(ids(read.turns), ['b', 'c']);
  assert.equal(read.earlierContentOmitted, true);
  assert.equal(read.turns[0].sourceSession, 'claude:n', 'as a whole read marks its turns');
  const whole = claudeReader({ [1 * MB]: { whole: true, turns: [turn('a')] } });
  assert.equal((await readPeerRecentTurns(claudeRecord, whole.reader, { enough: () => true })).earlierContentOmitted, false);
});

test('a chat that switched harness (more than one segment), a reader with no end read, and a read with no `enough` read the whole history', async () => {
  const { reader, all } = claudeReader({});
  const two = {
    segments: [
      { kind: 'claude', nativeId: 'n' },
      { kind: 'claude', nativeId: 'm' },
    ],
  };
  assert.deepEqual(ids((await readPeerRecentTurns(two, reader, { enough: () => true })).turns), ['all-1', 'all-2', 'all-1', 'all-2']);
  assert.equal(all.calls, 2, 'each segment whole');
  const plain = async () => ({ turns: [turn('whole')] });
  assert.deepEqual(ids((await readPeerRecentTurns(claudeRecord, plain, { enough: () => true })).turns), ['whole']);
  assert.deepEqual(ids((await readPeerRecentTurns(claudeRecord, reader, {})).turns), ['all-1', 'all-2']);
  await assert.rejects(readPeerRecentTurns(null, reader, { enough: () => true }), /chat_unavailable/);
});

test('by chat id, as main wires it: the chat is looked up and a native reader made for each recent read', async () => {
  const { reader, asked } = claudeReader({ [1 * MB]: { turns: [turn('a'), turn('b')] } });
  let made = 0;
  const records = new Map([['chat-1', claudeRecord]]);
  const byId = peerHistoryReader({ records }, () => (made++, reader));
  const read = await byId.recent('chat-1', { enough: atLeast(1) });
  assert.deepEqual(ids(read.turns), ['b']);
  assert.deepEqual(asked, [1]);
  await assert.rejects(byId.recent('gone', { enough: () => true }), /chat_unavailable/);
  assert.equal(made, 2);
});
