// electron/harness/claude/forks.cjs: the forks main made for a window, and discarding one no chat took (claude:discardFork).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakes, load, fakeBin, until, lastQuery } from './support/electron-claude.ts';
import { ChatsStore } from '../electron/platform/chats.cjs';

const require = createRequire(import.meta.url);
const { createForks } = require('../electron/harness/claude/forks.cjs');

function forks(o: { taken?: (key: string) => boolean; forked?: unknown } = {}) {
  const calls: unknown[][] = [];
  const deleted: string[] = [];
  const state = {
    sdk: async () => ({
      getSessionMessages: async (id: string) => (calls.push(['messages', id]), ['m']),
      forkSession: async (...a: unknown[]) => (calls.push(['fork', ...a]), o.forked === undefined ? { sessionId: 'f1' } : o.forked),
    }),
    sessions: new Map<string, unknown>(),
    retiring: new Map<string, unknown>(),
  };
  const f = createForks(
    state,
    (messages: unknown, uuid: string) => (uuid === 'p1' ? `end-of-${messages}` : null),
    async (id: string) => (deleted.push(id), true),
  );
  f.setChatNames(o.taken ?? (() => false));
  return { f, calls, deleted, state };
}

test('a fork ends at the turn asked for, or takes the whole chat', async () => {
  const { f, calls } = forks();
  assert.deepEqual(await f.fork('src', 'p1'), { sessionId: 'f1' });
  await f.fork('src', 'gone');
  await f.fork('src', null, true);
  assert.deepEqual(calls, [
    ['messages', 'src'],
    ['fork', 'src', { upToMessageId: 'end-of-m' }],
    ['messages', 'src'],
    ['fork', 'src', undefined],
    ['fork', 'src', undefined],
  ]);
});

test('only a fork made here, once, is discarded: never another session, nor one discarded already', async () => {
  const { f, deleted } = forks();
  await assert.rejects(f.discard('src'), /no chat has taken/);
  await assert.rejects(f.discard(7 as unknown as string), /no chat has taken/);
  await f.fork('src', null, true);
  // two windows (or a retry) discarding the same fork at once: the second is refused before the first's await ends
  const [first, second] = await Promise.allSettled([f.discard('f1'), f.discard('f1')]);
  assert.equal(first.status, 'fulfilled');
  assert.match(String((second as PromiseRejectedResult).reason), /no chat has taken/);
  assert.deepEqual(deleted, ['f1']);
});

test('a fork a chat, a live CLI or an ending one has is refused, and stays refused once it is free again', async () => {
  for (const holder of ['chat', 'sessions', 'retiring'] as const) {
    let named = holder === 'chat';
    const { f, deleted, state } = forks({ taken: (key) => (assert.equal(key, 'claude:f1'), named) });
    if (holder !== 'chat') state[holder].set('claude:f1', {});
    await f.fork('src', null, true);
    await assert.rejects(f.discard('f1'), /belongs to a chat/, holder);
    named = false;
    state.sessions.clear();
    state.retiring.clear();
    await assert.rejects(f.discard('f1'), /no chat has taken/, holder);
    assert.deepEqual(deleted, []);
  }
});

test("a fork not asked for as discardable (a whole chat's fork) is never discarded", async () => {
  for (const discardable of [undefined, false, 'true']) {
    const { f, deleted } = forks();
    await f.fork('src', null, discardable);
    await assert.rejects(f.discard('f1'), /no chat has taken/);
    assert.deepEqual(deleted, []);
  }
});

test('a claimed fork is not discarded, and an answer with no session id is never kept', async () => {
  const a = forks();
  await a.f.fork('src', null, true);
  a.f.claim('claude:f1');
  await assert.rejects(a.f.discard('f1'), /no chat has taken/);
  for (const forked of [null, {}, { sessionId: '' }, { sessionId: 3 }]) {
    const b = forks({ forked });
    await b.f.fork('src', null, true);
    await assert.rejects(b.f.discard(''), /no chat has taken/);
    await assert.rejects(b.f.discard('3'), /no chat has taken/);
    assert.deepEqual(b.deleted, []);
  }
});

test('in main a fork is claimed when it is named, opened or a CLI runs it, and refused until main says which chats own what', async () => {
  const bin = fakeBin('forks/claude');
  const t = load();
  let n = 0;
  fakes.sdk.forkSession = async () => ({ sessionId: `f${++n}` });
  const deleted: string[] = [];
  fakes.sdk.deleteSession = async (id: string) => (deleted.push(id), true);
  try {
    await t.call('claude:fork', 'src', null, true);
    // before main's chat store answers, every session counts as a chat's
    await assert.rejects(t.call('claude:discardFork', 'f1'), /belongs to a chat/);
    t.claude.setChatNames(() => false);
    await t.call('claude:fork', 'src', null, true);
    await t.call('claude:rename', 'f2', 'Named (fork)');
    await assert.rejects(t.call('claude:discardFork', 'f2'), /no chat has taken/);
    // a window opened it: its turns were read, or its transcript followed
    for (const channel of ['claude:turns', 'claude:watch']) {
      const { sessionId } = await t.call('claude:fork', 'src', null, true);
      await t.call(channel, sessionId, null);
      await assert.rejects(t.call('claude:discardFork', sessionId), /no chat has taken/, channel);
    }
    const ran = (await t.call('claude:fork', 'src', null, true)).sessionId;
    fakes.onQuery = (q: any) => (q.reply = null);
    await t.claude.send(`claude:${ran}`, { bin, sessionId: ran, resume: true }, { role: 'user', content: 'hi' });
    await until('the prompt', () => lastQuery().inputs.length === 1);
    // a CLI ran it: it stays the chat's after the CLI ends
    lastQuery().end();
    await until('the CLI to end', () => !t.claude.turnApi.isLive(`claude:${ran}`));
    await assert.rejects(t.call('claude:discardFork', ran), /no chat has taken/);
    // a fork nothing took goes, through the delete ChatDeletion uses (its CLI retired first)
    const free = (await t.call('claude:fork', 'src', null, true)).sessionId;
    assert.equal(await t.call('claude:discardFork', free), true);
    assert.deepEqual(deleted, [free]);
  } finally {
    t.claude.closeAll();
  }
});

test('the chat store names a session as a chat’s own first segment or a switch’s later one, in the window’s form', () => {
  // the production method over a memory-only store (constructing one would read the chats folder)
  const records = new Map([
    [
      'root',
      {
        segments: [
          { kind: 'codex', nativeId: 'root' },
          { kind: 'claude', nativeId: 'later' },
        ],
      },
    ],
    ['claude:own', { segments: [{ kind: 'claude', nativeId: 'own' }] }],
  ]);
  const store = Object.assign(Object.create(ChatsStore.prototype), { records });
  for (const key of ['root', 'claude:later', 'claude:own']) assert.equal(store.names(key), true, key);
  for (const key of ['later', 'own', 'claude:other']) assert.equal(store.names(key), false, key);
});

test('a fork from a turn before a compaction ends at that turn, not at the whole chat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-fork-compact-'));
  const file = path.join(dir, 'src.jsonl');
  const at = '2026-10-22T12:00:00Z';
  const line = (uuid: string, parentUuid: string | null, type: string, extra: object = {}) => ({
    uuid,
    parentUuid,
    type,
    sessionId: 'src',
    timestamp: at,
    ...extra,
  });
  const text = (uuid: string, parent: string | null, extra: object = {}) =>
    line(uuid, parent, 'user', { message: { role: 'user', content: uuid }, ...extra });
  fs.writeFileSync(
    file,
    [
      text('p1', null),
      line('r1', 'p1', 'assistant', { message: { id: 'r1', role: 'assistant', content: [{ type: 'text', text: 'r1' }] } }),
      line('b1', null, 'system', { subtype: 'compact_boundary', logicalParentUuid: 'r1' }),
      text('s1', 'b1', { isCompactSummary: true }),
      text('p2', 's1'),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  const { forkPoint } = require('../electron/harness/claude/transcriptEdits.cjs');
  const calls: unknown[][] = [];
  const f = createForks(
    {
      sdk: async () => ({
        // the SDK's reader starts after the compaction
        getSessionMessages: async () => [
          { uuid: 'b1', type: 'system' },
          { uuid: 's1', type: 'user', isCompactSummary: true, isMeta: true },
          { uuid: 'p2', type: 'user', message: { content: 'p2' } },
        ],
        forkSession: async (...a: unknown[]) => (calls.push(a), { sessionId: 'f1' }),
      }),
      sessions: new Map(),
      retiring: new Map(),
    },
    forkPoint,
    async () => true,
    async () => file,
  );
  await f.fork('src', 'p1');
  await f.fork('src', 'p2');
  assert.deepEqual(calls, [
    ['src', { upToMessageId: 'r1' }],
    ['src', { upToMessageId: 'p2' }],
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});
