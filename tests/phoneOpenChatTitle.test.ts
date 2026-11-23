// A chat opened from beyond the loaded pages (a link, a sub-session or a push tap) shows its own title, not "Chat": the pages are read until its row is found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { momoRuntime } from './support/phone/momo-kit';

const appPath = '../mobile/src/MobileApp';
const { MobileApp } = await import(appPath);

const ALL = Array.from({ length: 130 }, (_, i) => ({ id: `c${i}`, title: `Title ${i}`, harness: 'codex', at: 1000 - i }));
const page = ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) => ({
  chats: ALL.slice(offset, offset + limit),
  more: offset + limit < ALL.length,
});

/** A phone whose list has 130 chats in pages of 50, opened on the chat `target` by a push tap; `ids` names the chats the Mac has. */
async function open(target: string, answer: (p: any) => unknown = page) {
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
    'chats.recent': answer,
    'chat.follow': () => ({ rev: 1, feedSeq: 0, session: {}, itemsShape: 'rows', items: [] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: m.runtime, push })));
  await flush();
  ui = { ...ui, target: { pairId: 'p', chatId: target } };
  await act(async () => listeners.forEach((f) => f()));
  for (let i = 0; i < 6; i++) await flush();
  const asks = () => m.calls.filter(([method]) => method === 'chats.recent').map(([, p]) => p);
  const stop = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, asks, stop };
}

test('a chat on the third page names itself once its page is read, and only the pages up to it are read', async () => {
  const app = await open('c120');
  assert.match(app.host.textContent!, /Title 120/, 'the header names the chat');
  const offsets = [...new Set(app.asks().map((p: any) => p.offset ?? 0))].sort((a: number, b: number) => a - b);
  assert.deepEqual(offsets, [0, 50, 100], 'the first page, then the two after it, and no more');
  await app.stop();
});

test('a chat on the first page needs no further page, and one the Mac does not list stops after the pages it has', async () => {
  const near = await open('c3');
  assert.match(near.host.textContent!, /Title 3/);
  assert.ok(
    near.asks().every((p: any) => !p.offset),
    'no later page was read',
  );
  await near.stop();
  const missing = await open('nobody');
  assert.doesNotMatch(missing.host.textContent!, /Title nobody/);
  const later = new Set(
    missing
      .asks()
      .filter((p: any) => p.offset)
      .map((p: any) => p.offset),
  );
  assert.deepEqual(
    [...later].sort((a: number, b: number) => a - b),
    [50, 100],
    'the pages the Mac has, then it stops',
  );
  await missing.stop();
});

test('a chat the Mac does not list stops after ten pages, however many chats there are', async () => {
  const many = Array.from({ length: 1200 }, (_, i) => ({ id: `m${i}`, title: `Many ${i}`, harness: 'codex', at: 5000 - i }));
  const app = await open('nobody', ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) => ({
    chats: many.slice(offset, offset + limit),
    more: offset + limit < many.length,
  }));
  for (let i = 0; i < 20; i++) await flush();
  const offsets = [...new Set(app.asks().map((p: any) => p.offset ?? 0))];
  assert.ok(
    Math.max(...offsets) >= 400 && Math.max(...offsets) <= 500,
    `no more than ten pages were read, then it stopped (last offset ${Math.max(...offsets)})`,
  );
  await app.stop();
});
