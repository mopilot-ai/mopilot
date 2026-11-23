// The Chats home keeps the pages "Load more chats" loaded when a chat is opened and closed again (by state: one list; by project each project shows its first ten, phoneProjectWindow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { BY_STATE } from './support/phone/home-layout';
import { withOutbox } from './support/phone/outbox-kit';
const phoneModulePath = '../mobile/src/MobileApp';
const { MobileApp } = await import(phoneModulePath);

const online = {
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
const ALL = Array.from({ length: 120 }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}` }));
/** `chats.recent` as the Mac answers it: `limit` chats from `offset`, and whether more follow. */
const page = ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) => ({
  chats: ALL.slice(offset, offset + limit),
  more: offset + limit < ALL.length,
});

test('after Load more, opening a chat and coming back keeps every loaded page', async () => {
  const asks: any[] = [];
  const listeners = new Set<() => void>();
  const runtime: any = {
    snapshot: () => online,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    onEvent: () => () => {},
    request: async (method: string, params: any) => {
      if (method === 'chats.recent') {
        asks.push(params);
        return page(params);
      }
      return {};
    },
  };
  withOutbox(runtime, { notify: () => listeners.forEach((f) => f()) });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime, homeLayout: BY_STATE })));
  await flush();
  const shown = () => (host.textContent!.match(/Chat \d+/g) ?? []).length;
  assert.equal(shown(), 50, 'the first page');
  await click('Load more chats');
  assert.equal(shown(), 100, 'the second page');
  await click('Open chat Chat 3');
  await flush();
  await click('Back to chats');
  await flush();
  assert.equal(shown(), 100, 'both pages are still there after the chat closed');
  assert.deepEqual(asks.at(-1), { limit: 100 }, 'the list was read again for as many chats as were shown');
  assert.match(host.textContent!, /Chat 99/, 'the last loaded chat is still in the list');
  assert.ok(
    [...document.querySelectorAll('button')].some((b) => b.textContent === 'Load more chats'),
    'the rest are still one tap away',
  );
  await act(async () => root.unmount());
  host.remove();
});
