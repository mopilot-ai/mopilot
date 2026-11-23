// A machine side chat's first native session stays bound to the parent it forked and is reused on a safe retry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatPreparation } from '../host/src/chatPreparation.mjs';
import { sideChatParentOf } from '../host/src/nativeSideChat.mjs';
import { deferred } from './support/async-scenarios.ts';

const parent = 'claude:edf941f5-8483-42ca-a35d-bf4269d9d1a5';
const child = `claude:side-chat-${crypto.randomUUID()}`;
const nativeId = 'ed3b7373-5110-4821-ba5a-0c77247801ef';
const source = { chatId: parent, id: parent.slice(7), binding: 'original parent session and account' };

test('a captured native parent ends when the record or its current native segment changes', () => {
  const records = new Map();
  const original = { kind: 'claude', id: source.id, instance: null, key: parent };
  let current = original;
  const capture = sideChatParentOf({ records }, { ref: () => current });
  assert.equal(capture(parent), undefined);
  records.set(parent, {});
  const binding = capture(parent)!;
  assert.equal(binding.current(), true);
  for (const changed of [{ kind: 'codex' }, { id: nativeId }, { instance: 'different native instance' }]) {
    current = { ...original, ...changed } as typeof original;
    assert.equal(binding.current(), false);
  }
  current = original;
  records.delete(parent);
  assert.equal(binding.current(), false);
});

function setup() {
  const records = new Map();
  const transcript = new Set<string>();
  const forks: unknown[][] = [];
  const retired: string[] = [];
  const prepared: unknown[][] = [];
  const chats = {
    records,
    names: (id: string) => records.has(id),
    record: (id: string) =>
      records.get(id) ?? { id, segments: [{ nativeId: id.slice(7), kind: 'claude' }], meta: { account: { id: 'work' } } },
    commit: (record: any) => !!records.set(record.id, record),
  };
  const claude = {
    turnApi: { hasTranscript: async (id: string) => transcript.has(id) },
    forkLinkedSession: async (id: string, cwd: string, { check }: { check: () => void }) => {
      check();
      forks.push([id, cwd]);
      return { sessionId: nativeId };
    },
    deleteSession: async (id: string) => void retired.push(id),
  };
  const prepare = createChatPreparation({
    chats: chats as any,
    controller: { invalidate() {}, ref: (id: string) => ({ key: `claude:${chats.record(id).segments[0].nativeId}` }) } as any,
    claudeFamily: { claude, prepare: async (key, cwd) => void prepared.push([key, cwd]) },
  });
  return { prepare, chats, transcript, forks, retired, prepared, claude };
}

test('Claude forks the native parent once, preserves the child login, and resumes the same branch on retry', async () => {
  const s = setup();
  s.transcript.add(source.id);
  const p = { chatId: child, harness: 'claude', cwd: '/work', source };
  assert.equal(await s.prepare(p), true);
  assert.equal(await s.prepare(p), true);
  assert.deepEqual(s.forks, [[source.id, '/work']]);
  assert.deepEqual(s.prepared, [
    [`claude:${nativeId}`, '/work'],
    [`claude:${nativeId}`, '/work'],
  ]);
  assert.equal(s.chats.record(child).meta.account.id, 'work');
  await assert.rejects(s.prepare({ ...p, source: { ...source, binding: 'different account or session' } }), {
    code: 'side_chat_parent_changed',
  });
  assert.equal(s.prepared.length, 2);
});

test('when the parent changes during the native copy, the unused child is released and never bound', async () => {
  const s = setup();
  s.transcript.add(source.id);
  const entered = deferred<void>();
  const result = deferred<{ sessionId: string }>();
  s.claude.forkLinkedSession = () => (entered.resolve(), result.promise);
  const refusal = new Error('parent changed');
  let current = true;
  const opening = s.prepare({
    chatId: child,
    harness: 'claude',
    cwd: '/work',
    source,
    check: () => {
      if (!current) throw refusal;
    },
  });
  await entered.promise;
  current = false;
  result.resolve({ sessionId: nativeId });
  await assert.rejects(opening, (error) => error === refusal);
  assert.deepEqual(s.retired, [nativeId]);
  assert.equal(s.chats.records.has(child), false);
  assert.deepEqual(s.prepared, []);
});

test('a Claude copy preserves metadata written during setup', async () => {
  const s = setup();
  s.transcript.add(source.id);
  const result = deferred<{ sessionId: string }>();
  s.claude.forkLinkedSession = () => result.promise;
  const opening = s.prepare({ chatId: child, harness: 'claude', cwd: '/work', source });
  s.chats.commit({ ...s.chats.record(child), meta: { account: { id: 'work' }, title: 'A new side-chat title' } });
  result.resolve({ sessionId: nativeId });
  assert.equal(await opening, true);
  assert.equal(s.chats.record(child).meta.title, 'A new side-chat title');
  assert.equal(s.chats.record(child).segments[0].nativeId, nativeId);
});

test('a Claude fork may not bind or release a session that already has an owner', async () => {
  const s = setup();
  s.transcript.add(source.id);
  const owner = `claude:${nativeId}`;
  s.chats.commit(s.chats.record(owner));
  await assert.rejects(s.prepare({ chatId: child, harness: 'claude', cwd: '/work', source }), /separate side chat/);
  assert.deepEqual(s.retired, []);
  assert.equal(s.chats.records.has(child), false);
  assert.equal(s.chats.records.has(owner), true);
});
