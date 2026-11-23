// Cache-first offline history: a chat whose computer goes away still shows its last rows, kept per account, computer and chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
// through variables, so the desktop typecheck does not follow into React Native's global types
const appPath = '../mobile/src/MobileApp';
const cachePath = '../mobile/src/presentation/threadCache';
const { MobileApp } = await import(appPath);
const { rememberRows, recentRows, forgetRows, CACHE_CHATS, CACHE_ROWS } = await import(cachePath);

test('the cache keeps the newest chats and the last rows of each; an empty list keeps what was there; forgetting clears it', () => {
  forgetRows();
  rememberRows('a', [{ key: '1', role: 'user', text: 'hi' }]);
  rememberRows('a', []);
  assert.deepEqual(
    recentRows('a').map((r: { text: string }) => r.text),
    ['hi'],
    'a chat reloading does not wipe its rows',
  );
  const many = Array.from({ length: CACHE_ROWS + 5 }, (_, i) => ({ key: String(i), role: 'assistant', text: `r${i}` }));
  rememberRows('a', many);
  assert.equal(recentRows('a').length, CACHE_ROWS);
  assert.equal(recentRows('a')[0].text, 'r5', 'only the last rows');
  for (let i = 0; i < CACHE_CHATS; i++) rememberRows(`chat${i}`, [{ key: 'k', role: 'user', text: String(i) }]);
  assert.deepEqual(recentRows('a'), [], 'the oldest chat makes room');
  assert.equal(recentRows(`chat${CACHE_CHATS - 1}`).length, 1);
  forgetRows();
  assert.deepEqual(recentRows('chat0'), []);
  assert.deepEqual(recentRows('never'), []);
});

test('a chat waited for while its computer is away shows the rows it last showed; another account does not', async () => {
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
  assert.match(host.textContent!, /Fixed the import in build\.ts/);
  await change({ phase: 'offline', generation: 2, selectedPair: null, reconnect: { pairId: 'p', attempt: 1, nextAt: Date.now() + 5000 } });
  // the same chat screen stays: its laptop says the Mac is away, and it shows the last rows (the run by its summary)
  assert.ok(host.querySelector('button[aria-label^="Runs on"][aria-label$=", Offline"]'));
  assert.match(host.textContent!, /Fix the build▤Read 2 files›?Fixed the import in build\.ts/);
  assert.equal(s.calls.filter(([m]) => m === 'chat.follow').length, 1, 'nothing is followed while the Mac is away');
  // the composer is there to queue, and a message waiting for the Mac says so under it
  assert.ok(host.querySelector('[aria-label="Message this chat"]'));
  await change({
    outbox: [{ id: 'q1', pairId: 'p', chatId: 'c1', text: 'Then run the tests', attachments: [], at: 1, status: 'queued', error: null }],
  });
  assert.match(host.textContent!, /Then run the tests◷Will send when your computer reconnects/);
  // another account on this phone never sees them
  await change({ user: { id: 'other' }, generation: 3 });
  assert.doesNotMatch(host.textContent!, /Fixed the import/);
  await act(async () => root.unmount());
  host.remove();
});
