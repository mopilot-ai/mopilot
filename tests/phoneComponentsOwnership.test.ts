// Focused mobile component scenarios with native boundaries replaced by test controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
const phoneModulePath = '../mobile/src/MobileApp';
const { MobileApp } = await import(phoneModulePath);

test('malformed list and a retired failed list cannot overwrite newer account state', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let state: any = {
    phase: 'online',
    generation: 1,
    user: { id: 'u' },
    pairs: [],
    selectedPair: 'p',
    safetyNumber: null,
    pendingPair: false,
    presence: {},
    reconnect: null,
    outbox: [],
    error: null,
  };
  let listener = () => {};
  let reject: (e: any) => void = () => {};
  let reads = 0;
  const runtime: any = {
    snapshot: () => state,
    subscribe: (f: any) => ((listener = f), () => {}),
    // the Chats list asks the Mac for its machines; this Mac sends no events
    onEvent: () => () => undefined,
    start: async () => {},
    request: async () => {
      if (!reads++)
        return new Promise((_r, j) => {
          reject = j;
        });
      return {};
    },
  };
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  state = { ...state, generation: 2 };
  await act(async () => listener());
  await flush();
  assert.match(host.textContent!, /Could not read chats/);
  await act(async () => reject('old error'));
  await flush();
  assert.doesNotMatch(host.textContent!, /old error/);
  await act(async () => root.unmount());
  host.remove();
});

test('manual refresh completion from an old computer or account cannot replace current chat list or error', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let listener = () => {};
  let state: any = {
    phase: 'online',
    generation: 1,
    user: { id: 'one' },
    pairs: [],
    selectedPair: 'old',
    safetyNumber: null,
    pendingPair: false,
    presence: {},
    reconnect: null,
    outbox: [],
    pairCleanup: false,
    error: null,
  };
  const pending: any[] = [];
  const runtime: any = {
    snapshot: () => state,
    subscribe: (f: any) => ((listener = f), () => {}),
    // the Chats list asks the Mac for its machines; this Mac sends no events
    onEvent: () => () => undefined,
    start: async () => {},
    // the list's own reads are held to be answered in order; the machines' hello says this Mac has no Hosts
    request: async (method: string) =>
      method === 'machine.hello' ? {} : new Promise((resolve, reject) => pending.push({ resolve, reject })),
  };
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  await act(async () => pending[0].resolve({ chats: [{ id: 'old', title: 'Old chat' }] }));
  await flush();
  // idle chats are quiet: unfolded once, and they stay unfolded through the refreshes
  await click('Pull to refresh');
  state = { ...state, generation: 2, user: { id: 'two' }, selectedPair: 'new' };
  await act(async () => listener());
  await flush();
  await act(async () => pending[2].resolve({ chats: [{ id: 'new', title: 'New chat' }] }));
  await flush();
  await act(async () => pending[1].resolve({ chats: [{ id: 'stale', title: 'Stale chat' }] }));
  await flush();
  assert.match(host.textContent!, /New chat/);
  assert.doesNotMatch(host.textContent!, /Stale chat/);
  await click('Pull to refresh');
  state = { ...state, generation: 3, selectedPair: 'third' };
  await act(async () => listener());
  await flush();
  await act(async () => pending[4].resolve({ chats: [{ id: 'third', title: 'Third chat' }] }));
  await flush();
  await act(async () => pending[3].reject(Error('old failure')));
  await flush();
  assert.match(host.textContent!, /Third chat/);
  assert.doesNotMatch(host.textContent!, /old failure/);
  await act(async () => root.unmount());
  host.remove();
});

test('changing injected runtime unsubscribes the old instance and ignores its late startup failure', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let reject: (e: any) => void = () => {};
  let oldOff = 0;
  const oldListeners: (() => void)[] = [];
  let oldOn = 0;
  const base = (id: string) => ({
    snapshot: () => ({
      phase: 'signedOut',
      generation: 1,
      user: null,
      pairs: [],
      selectedPair: null,
      safetyNumber: null,
      pendingPair: false,
      presence: {},
      reconnect: null,
      outbox: [],
      pairCleanup: false,
      error: id,
    }),
    subscribe: () => () => {},
    // the Chats list asks the Mac for its machines; this Mac sends no events
    onEvent: () => () => undefined,
    start: async () => {},
    signIn: async () => {},
  });
  const old: any = {
    ...base('old'),
    subscribe: (f: any) => (
      oldListeners.push(f),
      oldOn++,
      () => {
        oldOff++;
      }
    ),
    start: async () =>
      new Promise((_r, j) => {
        reject = j;
      }),
  };
  const next: any = base('new');
  await act(async () => root.render(createElement(MobileApp, { runtime: old })));
  await act(async () => root.render(createElement(MobileApp, { runtime: next })));
  // the app root and the screens that read the outbox each subscribe, and every one of them lets go
  assert.ok(oldOn >= 1);
  assert.equal(oldOff, oldOn);
  await act(async () => {
    for (const listener of oldListeners) listener();
    reject(Error('late startup'));
  });
  await flush();
  assert.match(host.textContent!, /new/);
  assert.doesNotMatch(host.textContent!, /late startup/);
  await act(async () => root.unmount());
  host.remove();
});

test('a manual read overlapped by the read for a new computer uses the latest result and does not publish an older failure', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const pending: any[] = [];
  const listeners = new Set<() => void>();
  let generation = 1;
  const runtime: any = {
    snapshot: () => ({
      phase: 'online',
      generation,
      user: { id: 'u' },
      pairs: [],
      selectedPair: 'p',
      safetyNumber: null,
      pendingPair: false,
      presence: {},
      reconnect: null,
      outbox: [],
      pairCleanup: false,
      error: null,
    }),
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    // the Chats list asks the Mac for its machines; this Mac sends no events
    onEvent: () => () => undefined,
    start: async () => {},
    // the list's own reads are held to be answered in order; the machines' hello says this Mac has no Hosts
    request: async (method: string) =>
      method === 'machine.hello' ? {} : new Promise((resolve, reject) => pending.push({ resolve, reject })),
  };
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  await act(async () => pending[0].resolve({ chats: [] }));
  await flush();
  await click('Pull to refresh');
  // the refresh is still waiting when the phone moves to another computer, which reads its chats
  generation = 2;
  await act(async () => listeners.forEach((f) => f()));
  await flush();
  await act(async () => pending[2].resolve({ chats: [{ id: 'n', title: 'Latest' }] }));
  await flush();
  await act(async () => pending[1].reject(Error('older error')));
  await flush();
  assert.match(host.textContent!, /Latest/);
  assert.doesNotMatch(host.textContent!, /older error/);
  await act(async () => root.unmount());
  host.remove();
});

test('a chat with the same id on another paired Mac never displays that Mac’s queued image preview', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const state: any = {
    phase: 'online',
    generation: 1,
    user: { id: 'u' },
    selectedPair: 'current',
    pairs: [{ pairId: 'current', macId: 'm', name: 'Current Mac' }],
    presence: {},
    reconnect: null,
    pendingPair: false,
    safetyNumber: null,
    error: null,
    outbox: ['current', 'other'].map((pairId) => ({
      id: `send-${pairId}`,
      pairId,
      chatId: 'same-id',
      text: '',
      nativeId: `native-${pairId}`,
      images: 1,
      pictures: [`file:///${pairId}.jpg`],
      attachments: ['opaque'],
      at: 1,
      status: 'queued',
      error: null,
    })),
  };
  const runtime: any = {
    snapshot: () => state,
    subscribe: () => () => {},
    start: async () => {},
    onEvent: () => () => {},
    request: async (method: string) =>
      method === 'chats.recent'
        ? { chats: [{ id: 'same-id', title: 'Shared id' }] }
        : method === 'chat.follow'
          ? { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [] }
          : {},
  };
  try {
    await act(async () => root.render(createElement(MobileApp, { runtime })));
    await flush();
    await click('Open chat');
    assert(host.querySelector('img[src="file:///current.jpg"]'));
    assert.equal(host.querySelector('img[src="file:///other.jpg"]'), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
