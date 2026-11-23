// src/store/chatRetry.ts (#2503): Retry on a chat whose start main refused (a harness turned off remotely, MoMo's main chat
// held at its limit) sends the message main kept first in the queue once, or shows the banner again with the reason.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, sessions, resetState } = await loadStore();
const S = store;
const st = () => S.useStore.getState();
const { onCrashed } = await import('../src/store/connection.ts');
const HELD = 'MoMo is paused: Claude Code is at its limit.';
const retry = (id: string) => S.retryOpen(id, S.heldHead(sessions.sessionOf(id)));
const queued = (id: string, extra: object = {}) => ({ id, text: id, attachments: [], opts: {}, origin: null, queuedAt: 0, ...extra });

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  bootImpls();
  impl['session.snapshot'] = async () => null;
  impl['api.threadRead'] = async (id: string) => ({ thread: { id } });
  impl['api.threadTurns'] = async () => ({ data: [], nextCursor: null });
});

/** Main refused the chat's start: its session is crashed with the message first in line, and the chat shows why. */
function held(id: string, queue: object[] = [queued('q1')]) {
  sessions.useSessions.setState({ sessions: { [id]: { ...sessions.sessionOf(id), turn: 'crashed', crashed: HELD, queue } as any } });
  onCrashed(id, HELD);
  assert.equal(st().runtime[id].error, HELD);
}

for (const id of ['claude:held', 'codex-held', 'acp:kimi:held']) {
  test(`Retry sends the held message once the hold is gone, on ${id}`, async () => {
    held(id);
    impl['proxy.sendNow'] = async () => ({ status: 'sent' });
    await retry(id);
    await flush();
    assert.deepEqual(callsOf('proxy.sendNow'), [[id, 'q1']]);
    assert.equal(st().runtime[id].error, null);
  });
}

test('Retry while the hold stands shows the banner again with the reason, and keeps the message queued', async () => {
  held('claude:still');
  impl['proxy.sendNow'] = async () => ({ status: 'queued', error: HELD });
  await retry('claude:still');
  await flush();
  assert.equal(st().runtime['claude:still'].error, HELD);
  assert.equal(st().runtime['claude:still'].errorFromRead, false);
});

test('Retry says why when main could not take the message or the call fails', async () => {
  held('claude:fail');
  impl['proxy.sendNow'] = async () => ({ status: 'failed', error: 'The harness is down.' });
  await retry('claude:fail');
  await flush();
  assert.match(st().runtime['claude:fail'].error ?? '', /harness is down/i);
  held('claude:throws');
  impl['proxy.sendNow'] = async () => {
    throw new Error('bridge gone');
  };
  await retry('claude:throws');
  await flush();
  assert.match(st().runtime['claude:throws'].error ?? '', /Bridge gone/i);
  // no reason given: the banner still says something
  held('claude:silent');
  impl['proxy.sendNow'] = async () => ({ status: 'queued' });
  await retry('claude:silent');
  await flush();
  assert.ok(st().runtime['claude:silent'].error);
});

test('Retry sends exactly once: a second click while it is sending, or a message already gone, does not send again', async () => {
  held('claude:twice');
  let release!: (v: unknown) => void;
  impl['proxy.sendNow'] = () => new Promise((r) => (release = r));
  const first = retry('claude:twice');
  await flush();
  await retry('claude:twice');
  release({ status: 'sent' });
  await first;
  await flush();
  assert.equal(callsOf('proxy.sendNow').length, 1);
  // main already sent it (the queue entry is gone): nothing is shown
  held('claude:gone');
  impl['proxy.sendNow'] = async () => ({ status: 'missing' });
  await retry('claude:gone');
  await flush();
  assert.equal(st().runtime['claude:gone'].error, null);
});

test('Retry does not send what is not a refused start: a read failure, a message waiting for compaction, nothing queued, a running turn', async () => {
  const set = (id: string, s: object) => sessions.useSessions.setState({ sessions: { [id]: { ...sessions.sessionOf(id), ...s } as any } });
  impl['proxy.sendNow'] = async () => ({ status: 'sent' });
  // the chat's own read failed while a message waits
  set('read', { turn: 'crashed', queue: [queued('q1')] });
  S.useStore.setState({ runtime: { read: { error: 'read failed', errorFromRead: true } as any } });
  await retry('read');
  set('compaction', { turn: 'crashed', crashed: HELD, queue: [queued('q1', { waitingFor: 'compaction' })] });
  onCrashed('compaction', HELD);
  await retry('compaction');
  set('empty', { turn: 'crashed', crashed: HELD, queue: [] });
  onCrashed('empty', HELD);
  await retry('empty');
  set('running', { turn: 'running', crashed: null, queue: [queued('q1')] });
  S.useStore.setState((s) => ({ runtime: { ...s.runtime, running: { error: 'x', errorFromRead: false } as any } }));
  await retry('running');
  await flush();
  assert.equal(callsOf('proxy.sendNow').length, 0);
});
