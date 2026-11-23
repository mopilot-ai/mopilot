// A chat screen is not rebuilt by each attempt to reconnect: its field and keyboard stay while the Mac is away; another account gets a fresh one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
// through variables, so the desktop typecheck does not follow into React Native's global types
const appPath = '../mobile/src/MobileApp';
const cachePath = '../mobile/src/presentation/threadCache';
const { MobileApp } = await import(appPath);
const { forgetRows } = await import(cachePath);

test('each reconnect attempt keeps the same composer; another account gets a new one', async () => {
  forgetRows();
  const online = {
    phase: 'online',
    generation: 1,
    user: { id: 'u' },
    pairs: [{ pairId: 'p', macId: 'm', name: 'Mac' }],
    selectedPair: 'p',
    safetyNumber: null,
    pendingPair: false,
    error: null,
    presence: {},
    reconnect: null,
  };
  const follow = {
    rev: 1,
    feedSeq: 0,
    session: { turn: 'idle', cards: [] },
    itemsShape: 'rows',
    items: [
      { role: 'user', text: 'Fix the build' },
      // two steps in a row fold into one run, kept by its summary
      { role: 'step', text: 'Read build.ts' },
      { role: 'step', text: 'Read package.json' },
      { role: 'assistant', text: 'Fixed the import in build.ts' },
    ],
  };
  const s = scripted(
    (m) => (m === 'chats.recent' ? { chats: [{ id: 'c1', title: 'Build' }] } : m === 'chat.follow' ? follow : undefined),
    online,
  );
  s.runtime.start = async () => {};
  const listeners = new Set<() => void>();
  s.runtime.subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
  const change = async (patch: object) => {
    s.state.snap = { ...s.state.snap, ...patch };
    await act(async () => listeners.forEach((f) => f()));
    await flush();
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  await click('Open chat Build');
  const field = host.querySelector('[aria-label="Message this chat"]');
  assert.ok(field);
  await change({ phase: 'offline', generation: 2, selectedPair: null, reconnect: { pairId: 'p', attempt: 1, nextAt: Date.now() + 5000 } });
  assert.equal(host.querySelector('[aria-label="Message this chat"]'), field, 'the Mac going away keeps the field');
  await change({ generation: 3, reconnect: { pairId: 'p', attempt: 2, nextAt: Date.now() + 5000 } });
  assert.equal(host.querySelector('[aria-label="Message this chat"]'), field, 'a second attempt keeps it too');
  await change({ user: { id: 'other' }, generation: 4 });
  assert.notEqual(host.querySelector('[aria-label="Message this chat"]'), field, 'another account never gets the old screen');
  await act(async () => root.unmount());
  host.remove();
});
