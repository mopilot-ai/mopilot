// The phone's chat list pages: the Mac says there are more chats, "Load more chats" asks for the next page, and Refresh starts over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
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
const chatsOf = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${from + i}`, title: `Chat ${from + i}`, ...((from + i) % 2 ? { harness: 'codex' } : {}) }));

/** A phone on a Mac whose `chats.recent` is `answer`; every request it makes is kept. */
async function mount(answer: (params: any) => any) {
  const asks: any[] = [];
  const listeners = new Set<() => void>();
  const state = { snap: online as any };
  const runtime: any = {
    snapshot: () => state.snap,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    onEvent: () => () => {},
    request: async (method: string, params: any) => {
      if (method !== 'chats.recent') return {};
      asks.push(params);
      return answer(params);
    },
  };
  withOutbox(runtime, { notify: () => listeners.forEach((f) => f()) });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime })));
  await flush();
  // these chats have no state, so they are quiet: unfolded once, as a person reading the list would
  const rows = () => (host.textContent!.match(/Chat \d+/g) ?? []).length;
  const has = (title: string) => [...document.querySelectorAll('button')].some((b) => b.textContent === title);
  const stop = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, asks, rows, has, state, listeners, runtime, stop };
}

test('"Load more chats" appears only when the Mac says there are more, and asks for the page after the ones shown', async () => {
  const mac = await mount((p) => (p.offset ? { chats: chatsOf(3, 2), more: false } : { chats: chatsOf(0, 3), more: true }));
  assert.deepEqual(mac.asks, [{ limit: 50 }], 'the first page has no start');
  assert.equal(mac.rows(), 3);
  assert.ok(mac.has('Load more chats'));
  await click('Load more chats');
  assert.deepEqual(mac.asks.at(-1), { limit: 50, offset: 3 });
  assert.equal(mac.rows(), 5);
  assert.match(mac.host.textContent!, /Chat 4/);
  assert.equal(mac.has('Load more chats'), false, 'the last page ends the list');
  await mac.stop();
});

test('a Mac that does not page (no `more`) shows the list it has and no button', async () => {
  const mac = await mount(() => ({ chats: chatsOf(0, 4) }));
  assert.equal(mac.rows(), 4);
  assert.equal(mac.has('Load more chats'), false);
  await mac.stop();
});

test('a chat that moved between pages shows once, and Refresh starts over from the first page', async () => {
  let calls = 0;
  const mac = await mount((p) => {
    calls++;
    if (p.offset) return { chats: [...chatsOf(2, 1), ...chatsOf(3, 2)], more: false };
    return { chats: chatsOf(0, 3), more: true };
  });
  await click('Load more chats');
  assert.equal(mac.rows(), 5, 'c2 is on both pages and listed once');
  await click('Pull to refresh');
  assert.deepEqual(mac.asks.at(-1), { limit: 50 });
  assert.equal(mac.rows(), 3, 'the loaded pages are dropped on Refresh');
  assert.ok(mac.has('Load more chats'));
  assert.equal(calls, 3);
  await mac.stop();
});

test('a page that fails keeps the rows and the button, and the next tap asks again', async () => {
  let fail = true;
  const mac = await mount((p) => {
    if (!p.offset) return { chats: chatsOf(0, 3), more: true };
    if (fail) throw new Error('Mac went quiet');
    return { chats: chatsOf(3, 1), more: false };
  });
  await click('Load more chats');
  assert.equal(mac.rows(), 3);
  assert.match(mac.host.textContent!, /Mac went quiet/);
  assert.ok(mac.has('Load more chats'));
  fail = false;
  await click('Load more chats');
  assert.equal(mac.rows(), 4);
  assert.doesNotMatch(mac.host.textContent!, /Mac went quiet/);
  assert.deepEqual(
    mac.asks.map((a) => a.offset),
    [undefined, 3, 3],
  );
  await mac.stop();
});

test('a malformed page is refused and leaves the list as it was', async () => {
  const mac = await mount((p) => (p.offset ? { chats: [{ title: 'no id' }], more: true } : { chats: chatsOf(0, 2), more: true }));
  await click('Load more chats');
  assert.equal(mac.rows(), 2);
  assert.match(mac.host.textContent!, /Could not read chats\./);
  await mac.stop();
});

test('only one page is asked for at a time, and a page that lands after the list was refreshed is dropped', async () => {
  const late: { release?: (v: any) => void } = {};
  const mac = await mount((p) => (p.offset ? new Promise((resolve) => (late.release = resolve)) : { chats: chatsOf(0, 3), more: true }));
  const more = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Load more chats')!;
  await act(async () => more.click());
  const loading = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Loading…') as HTMLButtonElement;
  assert.ok(loading, 'the button says it is loading');
  assert.equal(loading.disabled, true);
  await click('Pull to refresh');
  late.release!({ chats: chatsOf(3, 2), more: false });
  await flush();
  assert.equal(mac.rows(), 3, 'the old page did not land on the fresh list');
  assert.ok(mac.has('Load more chats'), 'and the fresh list can load its second page');
  await mac.stop();
});

test('moving to another computer drops the loaded pages', async () => {
  const mac = await mount((p) => (p.offset ? { chats: chatsOf(3, 2), more: false } : { chats: chatsOf(0, 3), more: true }));
  await click('Load more chats');
  assert.equal(mac.rows(), 5);
  mac.state.snap = { ...online, phase: 'offline', generation: 2, selectedPair: null, error: 'Relay disconnected' };
  await act(async () => mac.listeners.forEach((f) => f()));
  await flush();
  // the list stays as the last one read, claims no state, and pages no more
  assert.equal(mac.rows(), 5);
  assert.equal(mac.has('Load more chats'), false);
  assert.match(document.body.textContent!, /Offline/);
  await mac.stop();
});

test('a double tap before the button redraws asks for one page, and a failure that is not an Error is shown as text', async () => {
  let plain = true;
  const mac = await mount((p) => {
    if (!p.offset) return { chats: chatsOf(0, 3), more: true };
    if (plain) throw 'relay closed';
    return { chats: chatsOf(3, 1), more: false };
  });
  const more = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Load more chats')!;
  await act(async () => {
    more.click();
    more.click();
  });
  await flush();
  assert.equal(mac.asks.filter((a) => a.offset).length, 1, 'the second tap found a page already on its way');
  assert.match(mac.host.textContent!, /relay closed/);
  plain = false;
  await click('Load more chats');
  assert.equal(mac.rows(), 4);
  await mac.stop();
});

test('while Refresh is on its way "Load more chats" waits, so a page from the old list never lands on the new one', async () => {
  const slow: { release?: (v: any) => void } = {};
  let refreshes = 0;
  const mac = await mount((p) => {
    if (p.offset) return { chats: chatsOf(p.offset, 2), more: true };
    // the first read answers at once; later ones (Refresh) wait to be released
    return refreshes++ ? new Promise((resolve) => (slow.release = resolve)) : { chats: chatsOf(0, 3), more: true };
  });
  await click('Load more chats');
  assert.equal(mac.rows(), 5);
  const refresh = document.querySelector('button[aria-label="Pull to refresh"]') as HTMLElement;
  await act(async () => refresh.click());
  const more = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Load more chats') as HTMLButtonElement;
  assert.equal(more.disabled, true, 'no page is asked for until the refresh answers');
  assert.equal(document.querySelector('button[aria-label="Refreshing"]') !== null, true, 'the list shows it is refreshing');
  await act(async () => more.click());
  assert.equal(mac.asks.filter((a) => a.offset === 5).length, 0, 'the waiting button asks for nothing');
  slow.release!({ chats: chatsOf(0, 3), more: true });
  await flush();
  assert.equal(mac.rows(), 3, 'the fresh first page, with no rows from the old list after it');
  const again = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Load more chats') as HTMLButtonElement;
  assert.equal(again.disabled, false);
  await mac.stop();
});
