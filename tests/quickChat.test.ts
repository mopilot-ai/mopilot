import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuickChatSender, quickChatSends } from '../src/lib/quickChat.ts';
const require = createRequire(import.meta.url);
const { QuickChatState, QuickChatRequests, rendererReadiness, knownChat, isQuickChatSender } = require('../electron/session/quickChat.cjs');

const key = { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false };
test('Quick Chat honors send keys, multiline input, and IME composition', () => {
  assert.equal(quickChatSends(key, 'enter', true), true);
  assert.equal(quickChatSends({ ...key, shiftKey: true }, 'enter', true), false);
  assert.equal(quickChatSends({ ...key, isComposing: true }, 'enter', true), false);
  assert.equal(quickChatSends(key, 'cmdEnter', true), false);
  assert.equal(quickChatSends({ ...key, metaKey: true }, 'cmdEnter', true), true);
  assert.equal(quickChatSends({ ...key, ctrlKey: true }, 'cmdEnter', false), true);
});

test('only one submission is accepted while a chat is being created', async () => {
  const sender = new QuickChatSender();
  let createCount = 0,
    sendCount = 0;
  let release!: (id: string) => void;
  const create = () => {
    createCount++;
    return new Promise<string>((r) => (release = r));
  };
  const send = async () => {
    sendCount++;
  };
  const first = sender.submit(' hi ', null, create, send);
  assert.equal(await sender.submit('hi', null, create, send), null);
  release('claude-123');
  assert.equal(await first, 'claude-123');
  assert.equal(createCount, 1);
  assert.equal(sendCount, 1);
});

test('failed delivery retries the same thread with the same request ID', async () => {
  const sender = new QuickChatSender();
  const calls: string[] = [];
  const send = async (_id: string, _text: string, requestId: string) => {
    calls.push(requestId);
    if (calls.length === 1) throw new Error('Disconnected');
  };
  await assert.rejects(
    sender.submit('hello', null, async () => 'same-chat', send),
    /Disconnected/,
  );
  assert.equal(
    await sender.submit(
      'hello',
      'same-chat',
      async () => {
        throw new Error('must not recreate');
      },
      send,
    ),
    'same-chat',
  );
  assert.equal(calls[0], calls[1]);
});

test('accepted Quick Chat requests are idempotent and rejected requests may be retried', async () => {
  const requests = new QuickChatRequests();
  let sent = 0;
  const item = { id: 'request-1', text: 'hi' };
  const dispatch = async () => ({ action: 'started', id: String(++sent) });
  const first = requests.send('chat', item, dispatch);
  assert.equal(requests.send('chat', item, dispatch), first);
  assert.deepEqual(await first, { action: 'started', id: '1' });
  assert.deepEqual(await requests.send('chat', item, dispatch), { action: 'started', id: '1' });
  assert.equal(sent, 1);
  await assert.rejects(
    requests.send('chat', { id: 'retry', text: 'x' }, () => {
      throw new Error('not ready');
    }),
    /not ready/,
  );
  assert.equal((await requests.send('chat', { id: 'retry', text: 'x' }, dispatch)).id, '2');
  assert.throws(() => requests.send('chat', { text: 'hi' }, dispatch), /Invalid/);
});

test('a Quick Chat retry after a refused or failed send is sent again under the same request id (#2229)', async () => {
  const requests = new QuickChatRequests();
  const item = { id: 'request-2229', text: 'hi' };
  const answers: unknown[] = [
    { action: 'failed', id: 'request-2229', error: 'The harness did not accept the message.' },
    new Error('The app window was closed'),
    { action: 'queued', id: 'request-2229', error: 'Claude is busy.' },
  ];
  let dispatched = 0;
  const dispatch = async () => {
    const answer = answers[dispatched++];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  assert.equal((await requests.send('chat', item, dispatch)).action, 'failed');
  await new Promise((r) => setImmediate(r));
  await assert.rejects(requests.send('chat', item, dispatch), /window was closed/);
  await new Promise((r) => setImmediate(r));
  // a queued receipt is accepted: main keeps the input, so a later retry answers it again and never sends twice
  assert.equal((await requests.send('chat', item, dispatch)).action, 'queued');
  await new Promise((r) => setImmediate(r));
  assert.equal((await requests.send('chat', item, dispatch)).action, 'queued');
  assert.equal(dispatched, 3);
});

test('Quick Chat restores thread and draft separately from main-window state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-chat-'));
  try {
    const chats = new Set(['claude:1']);
    const file = path.join(dir, 'quick-chat.json');
    const mainFile = path.join(dir, 'ui-state.json');
    fs.writeFileSync(mainFile, JSON.stringify({ newChatProjectId: 'project', sidebarOpen: false }));
    const store = new QuickChatState(file, (id: string) => chats.has(id));
    store.save({ threadId: 'claude:1', text: 'follow-up\n第二行' });
    assert.deepEqual(new QuickChatState(file, (id: string) => chats.has(id)).read(), { threadId: 'claude:1', text: 'follow-up\n第二行' });
    assert.equal(store.owns('claude:1'), true);
    assert.equal(store.owns('other-chat'), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(mainFile, 'utf8')), { newChatProjectId: 'project', sidebarOpen: false });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => store.save({ threadId: 'missing', text: 'draft' }), /Invalid/);
    chats.clear();
    assert.deepEqual(store.read(), { threadId: null, text: 'follow-up\n第二行' });
    store.save({ threadId: null, text: '' });
    assert.deepEqual(store.read(), { threadId: null, text: '' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new chat on any harness is a valid Quick Chat thread before it has a saved record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-chat-'));
  try {
    // Codex chats are saved when they start; Claude Code and ACP chats only have their adapter's session
    const records = new Map([['codex-1', {}]]);
    const claudeSessions = new Set(['claude:new']);
    const acpSessions = new Set(['acp:goose:new']);
    const known = knownChat(
      (id: string) => records.get(id),
      (id: string) => claudeSessions.has(id),
      (id: string) => acpSessions.has(id),
    );
    assert.equal(known('codex-1'), true);
    assert.equal(known('claude:new'), true);
    assert.equal(known('acp:goose:new'), true);
    assert.equal(known('missing'), false);
    const store = new QuickChatState(path.join(dir, 'quick-chat.json'), known);
    for (const id of ['codex-1', 'claude:new', 'acp:goose:new']) {
      store.save({ threadId: id, text: '' });
      assert.equal(store.owns(id), true);
      assert.deepEqual(store.read(), { threadId: id, text: '' });
    }
    assert.throws(() => store.save({ threadId: 'missing', text: '' }), /Invalid Quick Chat state/);
    assert.equal(knownChat()('codex-1'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff waits for an explicit renderer-ready signal, including multiple waiters', async () => {
  const ready = rendererReadiness();
  let completed = 0;
  const a = ready.wait(1).then(() => completed++);
  const b = ready.wait(1).then(() => completed++);
  await Promise.resolve();
  assert.equal(completed, 0);
  ready.mark(1);
  await Promise.all([a, b]);
  assert.equal(completed, 2);
  await ready.wait(1);
  ready.forget(1);
  let restored = false;
  const c = ready.wait(1).then(() => (restored = true));
  await Promise.resolve();
  assert.equal(restored, false);
  ready.mark(1);
  await c;
});

test('Quick Chat sender ownership requires the current live floating window', () => {
  const sender = {};
  const mini = { webContents: sender, isDestroyed: () => false };
  assert.equal(isQuickChatSender(mini, sender), true);
  assert.equal(isQuickChatSender(mini, {}), false);
  assert.equal(isQuickChatSender(null, sender), false);
  assert.equal(isQuickChatSender({ ...mini, isDestroyed: () => true }, sender), false);
});

test('closing a renderer rejects every readiness waiter immediately and clears its timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ready = rendererReadiness();
  const results: string[] = [];
  let otherReady = false;
  const other = ready.wait(2).then(() => {
    otherReady = true;
  });
  const waiting = [ready.wait(1), ready.wait(1)].map((p) =>
    p.then(
      () => results.push('ready'),
      (e: Error) => results.push(e.message),
    ),
  );
  ready.forget(1, true);
  await Promise.resolve();
  try {
    assert.deepEqual(results, ['The app window was closed', 'The app window was closed']);
    assert.equal(otherReady, false, 'closing one window does not settle another window');
  } finally {
    ready.mark(2);
    await other;
    t.mock.timers.tick(30_000);
    await Promise.all(waiting);
  }
  ready.mark(1);
  assert.equal(results.length, 2, 'late readiness cannot complete a retired waiter');
  await ready.wait(1);
});

test('a renderer reload keeps pending readiness waits until its new page is ready', async () => {
  const ready = rendererReadiness();
  let settled = false;
  const waiting = ready.wait(1).then(() => {
    settled = true;
  });
  ready.forget(1);
  await Promise.resolve();
  assert.equal(settled, false);
  ready.mark(1);
  await waiting;
  assert.equal(settled, true);
});

test('Quick Chat idempotency keeps distinct chat/request tuples even when their separators overlap', async () => {
  const requests = new QuickChatRequests();
  let dispatched = 0;
  const send = (chat: string, id: string) =>
    requests.send(chat, { id, text: 'message' }, () => ({ action: 'started', id: String(++dispatched) }));
  const first = send('claude:legacy', 'part:request');
  const second = send('claude:legacy:part', 'request');
  assert.notDeepEqual(await first, await second);
  assert.equal(dispatched, 2);
  assert.equal(send('claude:legacy', 'part:request'), first);
  assert.equal(send('claude:legacy:part', 'request'), second);
});
