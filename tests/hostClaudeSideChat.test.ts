// Native session allocation for a Claude Code side chat on a Host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createProtocol } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { helloParams } from '../shared/host/schema.mjs';
import { createFakeClaudeSdk } from './support/fakeClaudeSdk.mjs';
import { configDir, idle, keyOf, setup } from './support/host/claudeKit.ts';

test('a machine side chat resumes the SDK’s native copy of the current Claude transcript', async () => {
  const fake = createFakeClaudeSdk({ configDir, recordReplies: true });
  const fakeSdk = fake.sdk;
  const { forkSession, deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
  const forks: string[] = [];
  fake.sdk = async () => ({
    ...(await fakeSdk()),
    deleteSession,
    forkSession: (id: string) => {
      forks.push(id);
      return forkSession(id);
    },
  });
  const h = setup(undefined, fake);
  const report = () => undefined;
  const epochs = createEpochStore(path.join(h.dir, 'epochs.json'), { report });
  const guard = createGuard({ epochs, ledger: createLedger(path.join(h.dir, 'ledger'), { report }) });
  const protocol = createProtocol({ runtime: h.sessions.chatRuntime, epochs, guard, dataDir: h.dir, status: () => ({}) });
  const client = protocol.connection(() => undefined);
  const parent = keyOf();
  const child = `claude:side-chat-${crypto.randomUUID()}`;
  const start = { harness: 'claude', cwd: h.dir, epoch: 0 };
  try {
    await client.call('host.hello', helloParams());
    await client.call('chat.start', { ...start, chatId: parent, key: crypto.randomUUID(), text: 'a parent prompt' });
    await idle(h, parent);
    const source = h.sessions.controller.ref(parent).id;
    await client.call('chat.start', {
      ...start,
      chatId: child,
      key: crypto.randomUUID(),
      text: 'a child prompt',
      sideChat: { sourceId: parent, epoch: 0 },
    });
    await idle(h, child);
    const nativeId = h.sessions.controller.ref(child).id;
    assert.deepEqual(forks, [source]);
    assert.notEqual(nativeId, source);
    assert.equal(fake.queries.at(-1)?.options.resume, nativeId);
    assert.equal(h.text(child), 'fake-claude: a child prompt');
    await client.call('chat.remove', { chatId: child, key: crypto.randomUUID(), epoch: 0 });
    assert.equal(h.sessions.chats.saved(child), false);
    assert.equal(await h.family.claude.turnApi.hasTranscript(source), true);
  } finally {
    client.close();
    await h.close();
  }
});

test('a machine side chat has a separate Claude UUID that can be resumed', async () => {
  const h = setup();
  try {
    const uuid = crypto.randomUUID();
    const chatId = `claude:side-chat-${uuid}`;
    // The inherited login is written before the fork's native session starts.
    h.sessions.chats.patchMeta(chatId, { account: { id: 'default', pinned: true } });
    await h.sessions.chatRuntime.prepare({ chatId, harness: 'claude', cwd: h.dir });
    assert.deepEqual(h.sessions.chats.record(chatId).meta.account, { id: 'default', pinned: true });
    await h.sessions.chatRuntime.send({ key: chatId, text: 'side chat question', cwd: h.dir });
    await idle(h, chatId);
    const [query] = h.fake.queries;
    assert.match(query.options.sessionId, /^[0-9a-f-]{36}$/);
    assert.notEqual(query.options.sessionId, uuid);
    assert.notEqual(query.options.persistSession, false);
    assert.equal(h.text(chatId), 'fake-claude: side chat question');
  } finally {
    await h.close();
  }
});

test('failed Claude UUID persistence never opens a session', async () => {
  const h = setup();
  try {
    const id = `claude:side-chat-${crypto.randomUUID()}`;
    h.sessions.chats.admitCommit = () => false;
    await assert.rejects(h.sessions.chatRuntime.prepare({ chatId: id, harness: 'claude', cwd: h.dir }), /Could not record the side chat/);
    assert.equal(h.fake.queries.length, 0);
  } finally {
    await h.close();
  }
});
