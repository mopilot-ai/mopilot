// Host Codex side-chat forks preserve their source, release failed allocations and bound retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexChatStart } from '../host/src/codexChatStart.mjs';
import { deferred, tick } from './support/async-scenarios.ts';
import { useFakeClock } from './support/ports/clock.ts';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { base, installCodex, open, until } from './support/hostCodexKit.ts';

const { assertInputCurrent } = createRequire(import.meta.url)('../electron/session/contract/inputGuard.cjs');

test('the Host starts a side chat by forking the current native Codex thread', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'native-side-'));
  const h = await open(dir, { ...installCodex(dir).env, FAKE_CODEX_FORKS: '1' }, undefined, {}, { dataDir: dir });
  const parent = 'parent';
  const child = `side-chat-${crypto.randomUUID()}`;
  try {
    await h.call('chat.subscribe', parent);
    await h.call('chat.start', parent, { harness: 'codex', text: 'parent prompt', cwd: dir });
    await until(() => h.replies(parent).length);
    const source = h.sessions.controller.ref(parent).id;
    await h.call('chat.subscribe', child, { epoch: 0 });
    await h.call('chat.start', child, {
      epoch: 0,
      harness: 'codex',
      text: 'side fork prompt',
      cwd: dir,
      sideChat: { sourceId: parent, epoch: 1 },
    });
    await until(() => h.replies(child).length);
    const fork = h.requests().find((request) => request.method === 'thread/fork');
    assert.equal(fork?.params.threadId, source);
    assert.equal(fork?.params.excludeTurns, true);
    assert.equal(fork?.params.ephemeral, false);
    assert.equal(fork?.params.sandbox, 'read-only');
    assert.equal(fork?.params.deferGoalContinuation, true);
    assert.notEqual(h.sessions.controller.ref(child).id, source);
    assert.deepEqual(
      h.replies(child).map((reply) => reply.text),
      ['codex: side fork prompt'],
    );
    assert.equal(h.replies(parent).length, 1);
    assert.equal(h.sessions.chats.saved(child), true);
    await h.call('chat.remove', child, { epoch: 0 });
    assert.equal(h.sessions.chats.saved(child), false);
  } finally {
    h.close();
  }
});

test('a stale start deletes its allocated Codex thread and preserves the refusal if cleanup fails', async () => {
  const started = deferred<{ thread: { id: string } }>();
  const deleted: string[] = [];
  const adapter = {
    startThread: () => started.promise,
    async threadDelete(id: string) {
      deleted.push(id);
      throw new Error('The native process disconnected during cleanup.');
    },
  };
  const ctx = { paths: { dataDir: '/private' }, chats: { records: new Map(), commit: () => assert.fail('stale chat was recorded') } };
  const prepare = createCodexChatStart(adapter as any, ctx as any, () => ({}));
  const refusal = new Error('The parent chat changed.');
  let current = true;
  const pending = prepare({
    chatId: `side-chat-${crypto.randomUUID()}`,
    check: () => {
      if (!current) throw refusal;
    },
  });
  current = false;
  started.resolve({ thread: { id: 'native-side' } });
  await assert.rejects(pending, (error) => error === refusal);
  assert.deepEqual(deleted, ['native-side']);
});

test('a malformed Codex fork cannot become the child or delete the source', async () => {
  const deleted: string[] = [];
  const source = { chatId: 'parent', id: 'native-parent', binding: 'source' };
  let reply: object;
  const adapter = { fork: async () => reply, threadDelete: async (id: string) => void deleted.push(id) };
  const ctx = { chats: { records: new Map(), names: () => false, commit: () => assert.fail('an invalid fork was recorded') } };
  const prepare = createCodexChatStart(adapter as any, ctx as any, () => ({}));
  for (reply of [
    {},
    { thread: { id: 3 } },
    { thread: { id: '' } },
    { thread: { id: source.id } },
    { thread: { id: 'ephemeral-child', ephemeral: true } },
  ]) {
    await assert.rejects(async () => prepare({ chatId: 'side', source }), /didn't start|did not return/);
  }
  assert.deepEqual(deleted, ['ephemeral-child']);
});

test('a rejected Codex record releases only the unused fork and a retry can keep its own child', async () => {
  const records = new Map();
  const deleted: string[] = [];
  const source = { chatId: 'parent', id: 'native-parent', binding: 'source' };
  let allocated = 0;
  let admit = false;
  const adapter = {
    fork: async () => ({ thread: { id: `native-side-${++allocated}`, ephemeral: false } }),
    threadDelete: async (id: string) => void deleted.push(id),
  };
  const ctx = {
    chats: {
      records,
      names: () => false,
      record: (id: string) => records.get(id) ?? { id, meta: {} },
      commit: (record: any) => admit && !!records.set(record.id, record),
    },
    controller: () => ({ invalidate: () => undefined }),
  };
  const prepare = createCodexChatStart(adapter as any, ctx as any, () => ({}));
  const request = { chatId: 'side', source };
  await assert.rejects(prepare(request), /record the new chat/);
  assert.deepEqual(deleted, ['native-side-1']);
  assert.equal(records.size, 0);
  admit = true;
  assert.equal(await prepare(request), true);
  assert.equal(await prepare(request), true);
  assert.equal(allocated, 2);
  assert.equal(records.get('side').segments[0].nativeId, 'native-side-2');
});

test('a Codex receipt naming the parent’s new native segment never deletes it', async () => {
  const result = deferred<{ thread: { id: string } }>();
  const source = { chatId: 'parent', id: 'native-parent', binding: 'source' };
  let liveId = source.id;
  const adapter = {
    fork: () => result.promise,
    threadDelete: async () => assert.fail('an existing native segment must survive'),
  };
  const ctx = {
    chats: {
      records: new Map(),
      names: (id: string) => id === liveId,
      commit: () => assert.fail('an existing native segment is not a child'),
    },
  };
  const prepare = createCodexChatStart(adapter as any, ctx as any, () => ({}));
  const opening = prepare({
    chatId: 'side',
    source,
    check() {
      if (liveId !== source.id) throw new Error('parent changed');
    },
  });
  liveId = 'replacement-parent';
  result.resolve({ thread: { id: liveId } });
  await assert.rejects(opening, /parent changed/);
});

test('late Codex forks cannot dispatch after timeout or dispose of a recorded thread', async (t) => {
  const clock = useFakeClock(t);
  const source = { chatId: 'parent', id: 'native-parent', binding: 'source' };
  const deleted: string[] = [];
  const owned = new Set(['recorded-thread']);
  let params: unknown;
  const adapter = {
    fork: (input: unknown) => ((params = input), result.promise),
    async threadDelete(id: string, check: () => void) {
      check();
      deleted.push(id);
    },
  };
  const ctx = {
    chats: { records: new Map(), names: (id: string) => owned.has(id), commit: () => assert.fail('a late fork was recorded') },
  };
  const prepare = createCodexChatStart(adapter as any, ctx as any, () => ({}));
  let result: ReturnType<typeof deferred<{ thread?: { id: string } }>>;
  for (const thread of [{ id: 'unclaimed-thread' }, { id: 'recorded-thread' }, undefined]) {
    result = deferred();
    const opening = prepare({ chatId: 'side', source });
    const refused = assert.rejects(opening, { code: 'side_chat_fork_timeout' });
    clock.advance(30_000);
    await refused;
    assert.throws(() => assertInputCurrent(params), { code: 'side_chat_fork_timeout' });
    result.resolve({ thread });
    await tick();
  }
  assert.deepEqual(deleted, ['unclaimed-thread']);
  result = deferred();
  const opening = prepare({ chatId: 'side', source });
  const refused = assert.rejects(opening, { code: 'side_chat_fork_timeout' });
  clock.advance(30_000);
  await refused;
  result.reject(new Error('connection ended after the timeout'));
  await tick();
});

test('Codex checks ownership again before it dispatches a failed fork’s cleanup', async () => {
  const source = { chatId: 'parent', id: 'native-parent', binding: 'source' };
  const childId = 'unused-thread';
  const proceed = deferred<void>();
  const cleanup = deferred<unknown>();
  let owned = false;
  const adapter = {
    fork: async () => ({ thread: { id: childId } }),
    async threadDelete(_id: string, check: () => void) {
      await proceed.promise;
      try {
        check();
      } catch (error) {
        cleanup.resolve(error);
        throw error;
      }
      assert.fail('another chat now owns that thread');
    },
  };
  const ctx = {
    chats: {
      records: new Map(),
      names: () => owned,
      record: () => ({ id: 'side', meta: {} }),
      commit: () => false,
    },
  };
  const prepare = createCodexChatStart(adapter as any, ctx as any, () => ({}));
  await assert.rejects(prepare({ chatId: 'side', source }), /record the new chat/);
  owned = true;
  proceed.resolve();
  assert.match(String(await cleanup.promise), /separate side chat/);
});
