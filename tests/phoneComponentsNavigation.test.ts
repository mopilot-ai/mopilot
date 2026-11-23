// Focused mobile component scenarios with native boundaries replaced by test controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText, openComputer, openScanner } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
const phoneModulePath = '../mobile/src/MobileApp';
const { MobileApp } = await import(phoneModulePath);

test('account, pairing, thread and retryable input render through mobile components', async () => {
  let snap: any = {
    phase: 'online',
    generation: 1,
    user: { id: 'u' },
    pairs: [{ pairId: 'p', macId: 'm', name: 'Mac' }],
    selectedPair: 'p',
    safetyNumber: null,
    pendingPair: false,
    presence: {},
    reconnect: null,
    error: null,
  };
  const listeners = new Set<() => void>();
  const events = new Set<(e: any) => void>();
  let reject = true;
  const runtime: any = {
    snapshot: () => snap,
    subscribe: (f: any) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    signIn: async () => {},
    signOut: async () => {},
    pair: async () => {},
    cancelPairing: async () => {},
    connect: async () => {},
    onEvent: (f: any) => (events.add(f), () => events.delete(f)),
    request: async (method: string) => {
      if (method === 'chats.recent') return { chats: [{ id: 'c', title: 'Chat title' }] };
      if (method === 'chat.follow')
        return {
          rev: 1,
          feedSeq: 0,
          session: { turn: 'running', cards: [{ id: 'a', rev: 1, title: 'Approve?', choices: [{ key: 'yes', label: 'Yes' }] }] },
          itemsShape: 'rows',
          items: [],
        };
      if (method === 'chat.send' && reject) throw Error('refused');
      return {};
    },
  };
  withOutbox(runtime, { notify: () => listeners.forEach((f) => f()) });
  (globalThis as any).__phoneCamera = async () => ({ granted: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  assert.match(host.textContent!, /Chat title/);
  await click('Open chat');
  assert.match(host.textContent!, /Approve\?/);
  assert.match(host.textContent!, /Thinking…/);
  const input = host.querySelector('input')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'keep this');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Send');
  // the refused message stays on screen with what the computer said, ready to be sent again or cancelled
  assert.match(host.textContent!, /Not sent: refused/);
  assert.match(host.textContent!, /keep this/);
  assert.equal(input.value, '');
  await click('Yes');
  await click('Back to chats');
  await click('Settings');
  await click('Add a computer');
  await openScanner();
  await flush();
  assert.match(host.textContent!, /Camera access is off/);
  await act(async () => root.unmount());
  host.remove();
});

test('account and computer states expose sign-in, pairing confirmation, reconnect and refresh failures', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  // the app root and each screen that reads the outbox subscribe on their own
  const subs = new Set<() => void>();
  const listener = () => subs.forEach((f) => f());
  let sign = 0;
  let cancel = 0;
  let connections = 0;
  let response: any = { chats: [] };
  let state: any = {
    phase: 'loading',
    generation: 1,
    user: null,
    pairs: [],
    selectedPair: null,
    safetyNumber: null,
    pendingPair: false,
    presence: {},
    reconnect: null,
    outbox: [],
    error: null,
  };
  const runtime: any = {
    snapshot: () => state,
    subscribe: (f: any) => (subs.add(f), () => void subs.delete(f)),
    // the Chats list asks the Mac for its machines; this Mac sends no events
    onEvent: () => () => undefined,
    start: async () => {},
    signIn: async () => {
      sign++;
    },
    signOut: async () => {},
    cancelPairing: async () => {
      cancel++;
    },
    connect: async () => {
      connections++;
    },
    request: async () => response,
  };
  const change = async (p: any) => {
    state = { ...state, ...p };
    await act(async () => listener());
    await flush();
  };
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  assert.match(host.textContent!, /Loading your account/);
  await change({ phase: 'signedOut' });
  await click('Sign in');
  assert.equal(sign, 1);
  await change({ phase: 'ready', user: { id: 'u', email: 'e' }, pendingPair: true, safetyNumber: '123456' });
  await click('Check the number');
  assert.match(host.textContent!, /123 456/);
  await click('Cancel pairing');
  assert.equal(cancel, 1);
  await change({ pendingPair: false, pairs: [], phase: 'offline' });
  assert.match(host.textContent!, /No computer of yours yet/);
  assert.match(host.textContent!, /Add a computer to see its chats here/);
  assert.doesNotMatch(host.textContent!, /offline/, 'after a cancelled pairing there is no computer to be offline');
  await click('Add a computer');
  await openScanner();
  await click('Close');
  await change({ phase: 'online', pairs: [{ pairId: 'p', macId: 'm' }], selectedPair: 'p' });
  await flush();
  assert.match(host.textContent!, /No recent chats/);
  await click('Settings');
  await openComputer();
  await click('Reconnect');
  assert.equal(connections, 1);
  await click('Back');
  await click('Close');
  response = { wrong: true };
  await click('Pull to refresh');
  assert.match(host.textContent!, /Could not read chats/);
  response = { chats: [] };
  await click('Pull to refresh');
  await click('Settings');
  await click('Sign out');
  await click('Confirm sign out');
  await act(async () => root.unmount());
  host.remove();
});

test('account list failure can refresh and a successful send clears the owned draft', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let count = 0;
  const listeners = new Set<() => void>();
  const runtime: any = {
    snapshot: () => ({
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
    }),
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    onEvent: () => () => {},
    request: async (method: string) => {
      if (method === 'chats.recent') {
        if (!count++) throw Error('list failed');
        return { chats: [{ id: 'c' }] };
      }
      if (method === 'chat.follow')
        return { rev: 0, feedSeq: 0, session: {}, itemsShape: 'rows', items: [{ role: 'note', text: 'Notice' }] };
      return {};
    },
  };
  withOutbox(runtime, { notify: () => listeners.forEach((f) => f()) });
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  assert.match(host.textContent!, /list failed/);
  await click('Pull to refresh');
  assert.doesNotMatch(host.textContent!, /list failed/);
  await click('Open chat');
  await inputText('Message this chat', 'send me');
  await click('Send');
  assert.equal((host.querySelector('input') as HTMLInputElement).value, '');
  assert.ok(host.querySelector('[aria-label^="Activity:"]'));
  await act(async () => root.unmount());
  host.remove();
});

test('account startup and action errors remain visible and paired computers can connect', async () => {
  // earlier tests leave their screens mounted; this one clicks by label across the document
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  // the app root and each screen that reads the outbox subscribe on their own
  const subs = new Set<() => void>();
  const listener = () => subs.forEach((f) => f());
  let state: any = {
    phase: 'ready',
    generation: 1,
    user: { id: 'u' },
    pairs: [
      { pairId: 'a', macId: 'a' },
      { pairId: 'b', macId: 'b', name: 'Other' },
    ],
    selectedPair: 'a',
    presence: {},
    reconnect: null,
    outbox: [],
    safetyNumber: null,
    pendingPair: true,
    error: null,
  };
  const runtime: any = {
    snapshot: () => state,
    subscribe: (f: any) => (subs.add(f), () => void subs.delete(f)),
    // the Chats list asks the Mac for its machines; this Mac sends no events
    onEvent: () => () => undefined,
    start: async () => {
      throw 'startup failed';
    },
    signOut: async () => {
      throw 'signout failed';
    },
    cancelPairing: async () => {},
    connect: async () => {
      throw 'connect failed';
    },
    request: async () => ({}),
  };
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  assert.match(host.textContent!, /startup failed/);
  assert.match(host.textContent!, /Click Connect in MoPilot on your computer\./);
  state = { ...state, pendingPair: false };
  await act(async () => listener());
  // a paired Mac that is away is connected from its row in Settings, where the failure shows
  await click('Settings');
  await openComputer();
  await click('Connect');
  assert.match(host.textContent!, /connect failed/);
  await click('Back');
  await click('Sign out');
  await click('Confirm sign out');
  assert.match(host.textContent!, /signout failed/);
  await act(async () => root.unmount());
  host.remove();
});

test('string failures from list, follow and send are shown', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let phase = 'list';
  let failures = 0;
  const listeners = new Set<() => void>();
  const runtime: any = {
    snapshot: () => ({
      phase: 'online',
      generation: 1,
      user: { id: 'u' },
      pairs: [],
      selectedPair: 'p',
      safetyNumber: null,
      pendingPair: false,
      presence: {},
      reconnect: null,
      error: null,
    }),
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    onEvent: () => () => {},
    request: async (method: string) => {
      if (method === 'chats.recent') {
        if (!failures++) throw 'string list';
        return { chats: [{ id: 'c' }] };
      }
      if (method === 'chat.follow') {
        if (phase === 'list') {
          phase = 'retry';
          throw 'string follow';
        }
        return { rev: 0, feedSeq: 0, session: {}, itemsShape: 'rows', items: [] };
      }
      if (method === 'chat.send') throw 'string send';
      return {};
    },
  };
  withOutbox(runtime, { notify: () => listeners.forEach((f) => f()) });
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  assert.match(host.textContent!, /string list/);
  await click('Pull to refresh');
  await click('Open chat');
  assert.match(host.textContent!, /string follow/);
  await click('Retry');
  await inputText('Message this chat', 'text');
  await click('Send');
  await flush();
  assert.match(host.textContent!, /The message was not sent/);
  await act(async () => root.unmount());
  host.remove();
});

test('startup failure offers retry and interrupted pairing offers cleanup retry', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  // the app root and each screen that reads the outbox subscribe on their own
  const subs = new Set<() => void>();
  const listener = () => subs.forEach((f) => f());
  let starts = 0;
  let cleanups = 0;
  let state: any = {
    phase: 'error',
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
    error: 'Storage unavailable',
  };
  const runtime: any = {
    snapshot: () => state,
    subscribe: (f: any) => (subs.add(f), () => void subs.delete(f)),
    // the Chats list asks the Mac for its machines; this Mac sends no events
    onEvent: () => () => undefined,
    start: async () => {
      starts++;
    },
    cancelPairing: async () => {
      cleanups++;
      if (cleanups === 1) throw Error('Cleanup failed');
    },
    request: async () => ({}),
  };
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  assert.match(host.textContent!, /Storage unavailable/);
  await click('Retry');
  assert.equal(starts, 2);
  state = { ...state, phase: 'ready', user: { id: 'u' }, pendingPair: true, pairCleanup: true, error: 'Interrupted' };
  await act(async () => listener());
  assert.doesNotMatch(host.textContent!, /Waiting for approval/);
  await click('Remove unfinished pairing');
  assert.match(host.textContent!, /Cleanup failed/);
  await click('Remove unfinished pairing');
  assert.equal(cleanups, 2);
  await act(async () => root.unmount());
  host.remove();
});

test('startup Error reaches current view', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const runtime: any = {
    snapshot: () => ({
      phase: 'error',
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
      error: null,
    }),
    subscribe: () => () => {},
    // the Chats list asks the Mac for its machines; this Mac sends no events
    onEvent: () => () => undefined,
    start: async () => {
      throw Error('cannot load');
    },
    request: async () => ({}),
  };
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  assert.match(host.textContent!, /cannot load/);
  await act(async () => root.unmount());
  host.remove();
});
