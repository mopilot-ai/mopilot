// The chats list is read again when the open chat changes, so a card answered inside a chat (or its sub-session) does not leave the list's amber behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { momoRuntime } from './support/phone/momo-kit';

const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);

test('opening a chat and coming back reads the list again; a chat that is open does not re-read it by itself', async () => {
  let ui: any = { step: 'granted', busy: false, target: null, prefs: {}, notice: null, token: null };
  const listeners = new Set<() => void>();
  const push: any = {
    ui: () => ui,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    stop: () => {},
    consumeTarget: () => {
      ui = { ...ui, target: null };
    },
    setOpenChat: () => {},
    signOut: async () => {},
  };
  const m = momoRuntime({
    'machine.hello': () => ({ v: 1, capabilities: { methods: [] } }),
    'chats.recent': () => ({ chats: [{ id: 'c1', title: 'Parent', harness: 'codex', at: 1 }] }),
    'chat.follow': () => ({}),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: m.runtime, push })));
  await flush();
  const reads = () => m.calls.filter(([method]) => method === 'chats.recent').length;
  const first = reads();
  assert.ok(first >= 1, 'the list was read on connect');
  ui = { ...ui, target: { pairId: 'p', chatId: 'c1' } };
  await act(async () => listeners.forEach((f) => f()));
  await flush();
  assert.equal(reads(), first + 1, 'opening a chat reads the list');
  await flush();
  assert.equal(reads(), first + 1, 'nothing re-reads it while the chat stays open');
  await click('Back to chats');
  await flush();
  assert.equal(reads(), first + 2, 'coming back reads it again');
  await act(async () => root.unmount());
  host.remove();
});
