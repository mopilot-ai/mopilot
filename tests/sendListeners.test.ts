// src/store/send.ts: who hears of a message main took, with the harness it runs on (src/session/newChatStart.ts).
import { test, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll, bootImpls } from './support/store-harness.ts';

const { store: S, sessions, resetState } = await loadStore();
const session = (id: string, o: any) =>
  sessions.useSessions.setState((s) => ({ sessions: { ...s.sessions, [id]: { ...sessions.sessionOf(id), rev: 1, ...o } } }));

before(() => bootImpls());
beforeEach(() => {
  resetState();
  resetAll();
  bootImpls();
  impl['proxy.send'] = async () => ({ action: 'started', id: 'turn' });
});

test('a message main took is heard with its harness; one carrying a switch with the harness it switches to', async () => {
  const heard: [string, string][] = [];
  const off = S.onMessageSent((id: string, kind: string) => heard.push([id, kind]));
  try {
    await S.sendMessage('c1', 'hello');
    session('c2', { pendingSwitch: { harness: 'claude', model: null, modelLabel: 'Default', mode: 'workspace' } });
    await S.sendMessage('c2', 'switch me');
    // queued behind a running turn: taken all the same
    impl['proxy.send'] = async () => ({ action: 'queued', id: 'q' });
    await S.sendMessage('c1', 'later');
    assert.deepEqual(heard, [
      ['c1', 'codex'],
      ['c2', 'claude'],
      ['c1', 'codex'],
    ]);
  } finally {
    off();
  }
  await S.sendMessage('c1', 'unheard');
  assert.equal(heard.length, 3, 'a listener that stopped hears nothing more');
});

test('a message main kept with a reason, discarded or refused is not heard', async () => {
  const heard: string[] = [];
  const off = S.onMessageSent((id: string) => heard.push(id));
  try {
    impl['proxy.send'] = async () => ({ action: 'queued', id: 'q', error: 'Codex is busy.' });
    await S.sendMessage('c1', 'kept');
    impl['proxy.send'] = async () => ({ action: 'discarded', id: 'd' });
    await S.sendMessage('c1', 'dropped');
    impl['proxy.send'] = async () => ({ action: 'failed', id: 'f', error: 'no' });
    assert.equal(await S.sendMessage('c1', 'refused'), false);
    assert.deepEqual(heard, []);
  } finally {
    off();
  }
});
