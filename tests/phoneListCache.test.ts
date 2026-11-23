// The chat list at launch: the last list read from a computer paints from a sealed copy at once, opens its chats as an away computer's do, and the live list replaces it in place; the saved copy is bounded, sealed to its key and gone with the account or the computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush, openComputer } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';

// through variables, so the desktop typecheck does not follow into React Native's global types
const listPath = '../mobile/src/presentation/listCache';
const appPath = '../mobile/src/MobileApp';
const hookPath = '../mobile/src/useChatList';
const { createListCache, LIST_KEPT } = await import(listPath);
const { LIST_REREAD_MS } = await import(hookPath);
const { MobileApp } = await import(appPath);

function memoryStore() {
  const table = new Map<string, string>();
  return {
    table,
    store: {
      read: async (k: string) => table.get(k) ?? null,
      write: async (k: string, v: string) => void table.set(k, v),
      remove: async (k: string) => void table.delete(k),
      keys: async () => [...table.keys()],
      clear: async () => table.clear(),
    },
  };
}
// the box is the plain text with the aad in front, so a list moved to another key fails to open as a real AEAD would
const crypto = {
  key: async () => new Uint8Array(32),
  randomBytes: (n: number) => new Uint8Array(n).fill(7),
  seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
    new Uint8Array([...new TextEncoder().encode(`${aad}|`), ...plain]),
  open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
    const text = new TextDecoder().decode(box);
    return text.startsWith(`${aad}|`) ? box.slice(aad.length + 1) : null;
  },
};
const cacheOver = () => {
  const m = memoryStore();
  return { ...m, cache: createListCache({ store: m.store, crypto }) };
};
// a running chat is in the home's active group; an idle one would be folded into Quiet
const chat = (id: string) => ({ id, title: `Chat ${id}`, state: 'running', harness: 'claude', project: 'App' });

test('a list is saved sealed and read back for its key only; an empty list keeps nothing', async () => {
  const { cache, table } = cacheOver();
  assert.deepEqual(await cache.load('a'), []);
  await cache.save('a', [chat('1'), chat('2')]);
  assert.ok(!JSON.stringify([...table.values()]).includes('Chat 1'), 'only ciphertext reaches the store');
  assert.deepEqual(
    (await cache.load('a')).map((c) => c.id),
    ['1', '2'],
  );
  table.set('b', table.get('a')!);
  assert.deepEqual(await cache.load('b'), [], 'a sealed list moved to another key does not open');
  await cache.save('a', []);
  assert.equal(table.has('a'), false);
});

test('a saved list is bounded, and what cannot be read is no list', async () => {
  const { cache, table } = cacheOver();
  await cache.save(
    'a',
    Array.from({ length: LIST_KEPT + 5 }, (_, i) => chat(String(i))),
  );
  assert.equal((await cache.load('a')).length, LIST_KEPT);
  table.set('bad', 'not json');
  assert.deepEqual(await cache.load('bad'), []);
  const forged = createListCache({ store: memoryStore().store, crypto: { ...crypto, open: () => new TextEncoder().encode('{"a":1}') } });
  await forged.save('k', [chat('1')]);
  assert.deepEqual(await forged.load('k'), [], 'a sealed value that is not a list is no list');
  const mixed = createListCache({
    store: memoryStore().store,
    crypto: { ...crypto, open: () => new TextEncoder().encode(JSON.stringify([chat('1'), null, { title: 'no id' }, chat('2')])) },
  });
  await mixed.save('k', [chat('1')]);
  assert.deepEqual(
    (await mixed.load('k')).map((c) => c.id),
    ['1', '2'],
    'entries with no id are dropped',
  );
});

test('a computer removed takes its list; signing out takes every list; a save begun before either does not write after it', async () => {
  const { cache, table } = cacheOver();
  await cache.save('["u","p1"]', [chat('1')]);
  await cache.save('["u","p2"]', [chat('2')]);
  await cache.prune((key) => (JSON.parse(key) as string[])[1] !== 'p1');
  assert.deepEqual([...table.keys()], ['["u","p2"]']);
  let release: () => void = () => undefined;
  const slow = createListCache({
    store: memoryStore().store,
    crypto: { ...crypto, key: () => new Promise<Uint8Array>((r) => (release = () => r(new Uint8Array(32)))) },
  });
  const pending = slow.save('k', [chat('1')]);
  await slow.clear();
  release();
  await pending;
  assert.deepEqual(await slow.load('k'), []);
  await cache.clear();
  assert.equal(table.size, 0);
});

const paired = { generation: 1, user: { id: 'u', name: 'Dana' }, pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }], error: null };

test('launch: the saved list paints before the computer is reached, its chat opens without asking the computer, and the live list replaces it in place and is saved', async () => {
  const { cache, table } = cacheOver();
  await cache.save(JSON.stringify(['u', 'p']), [chat('old1'), chat('old2')]);
  let live = [chat('new1'), chat('old2'), chat('new3')];
  const s = scripted((m) => (m === 'chats.recent' ? { chats: live } : undefined), { ...paired, phase: 'ready', selectedPair: null });
  s.runtime.start = async () => {};
  const subscribers = new Set<() => void>();
  s.runtime.subscribe = (f: () => void) => (subscribers.add(f), () => subscribers.delete(f));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, lists: Promise.resolve(cache) })));
  await flush();
  const rows = () => [...host.querySelectorAll('button[aria-label^="Open chat"]')].map((b) => b.getAttribute('aria-label'));
  assert.deepEqual(
    rows(),
    ['Open chat Chat old1', 'Open chat Chat old2'],
    'the list is on screen while the first connection is still being made',
  );
  assert.equal(s.calls.filter(([m]) => m === 'chats.recent').length, 0, 'nothing was asked of the computer yet');
  await act(async () => (host.querySelector('button[aria-label="Open chat Chat old1"]') as HTMLElement).click());
  await flush();
  assert.equal(
    s.calls.filter(([m]) => m === 'chat.follow').length,
    0,
    'a chat opened from the saved list waits for the computer instead of asking it before it is there',
  );
  await act(async () => (host.querySelector('button[aria-label="Back to chats"]') as HTMLElement).click());
  await flush();
  s.state.snap = { ...paired, phase: 'online', selectedPair: 'p' };
  await act(async () => subscribers.forEach((f) => f()));
  await flush();
  await flush();
  assert.deepEqual(
    rows(),
    ['Open chat Chat new1', 'Open chat Chat old2', 'Open chat Chat new3'],
    'the computer’s list took the saved one’s place',
  );
  const saved = await cache.load(JSON.stringify(['u', 'p']));
  assert.deepEqual(
    saved.map((c) => c.id),
    ['new1', 'old2', 'new3'],
    'what the computer answered is what is kept for the next launch',
  );
  assert.equal(table.size, 1);
  await act(async () => root.unmount());
  host.remove();
  live = [];
});

test('a list saved for another computer or account is not shown, and a list that cannot be opened leaves the usual Loading chats…', async () => {
  const { cache } = cacheOver();
  await cache.save(JSON.stringify(['someone-else', 'p']), [chat('x')]);
  const s = scripted(() => undefined, { ...paired, phase: 'ready', selectedPair: null });
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const broken = { ...cache, load: () => Promise.reject(new Error('disk')) };
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, lists: Promise.resolve(broken as any) })));
  await flush();
  assert.equal(host.querySelectorAll('button[aria-label^="Open chat"]').length, 0);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, lists: Promise.resolve(cache) })));
  await flush();
  assert.equal(host.querySelectorAll('button[aria-label^="Open chat"]').length, 0, 'another account’s list is never shown');
  await act(async () => root.unmount());
  host.remove();
});

test('signing out clears every saved list; removing a computer clears only its list', async () => {
  const away = { ...paired, phase: 'offline', selectedPair: null };
  for (const how of ['signOut', 'unpair']) {
    const { cache } = cacheOver();
    await cache.save(JSON.stringify(['u', 'p']), [chat('1')]);
    await cache.save(JSON.stringify(['u', 'q']), [chat('2')]);
    const s = scripted(() => undefined, away);
    s.runtime.start = async () => {};
    s.runtime.signOut = async () => {};
    s.runtime.unpair = async () => {};
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, lists: Promise.resolve(cache) })));
    await flush();
    // with a list on the home, Settings is in the drawer
    await click('Open menu');
    await click('Settings');
    if (how === 'signOut') {
      await click('Sign out');
      await click('Confirm sign out');
      await flush();
      assert.deepEqual(await cache.load(JSON.stringify(['u', 'p'])), []);
      assert.deepEqual(await cache.load(JSON.stringify(['u', 'q'])), [], 'every list goes with the account');
    } else {
      await openComputer();
      await click('Remove computer');
      await click('Remove');
      await flush();
      assert.deepEqual(await cache.load(JSON.stringify(['u', 'p'])), [], 'the removed computer’s list goes');
      assert.equal((await cache.load(JSON.stringify(['u', 'q']))).length, 1, 'another computer’s list stays');
    }
    await act(async () => root.unmount());
    host.remove();
  }
});

const online = { ...paired, phase: 'online', selectedPair: 'p' };

test('a saved list that is read after the live one landed, or after the screen is gone, changes nothing', async () => {
  const { cache } = cacheOver();
  await cache.save(JSON.stringify(['u', 'p']), [chat('old')]);
  let late: (v: unknown) => void = () => undefined;
  const slow = { ...cache, load: () => new Promise<any>((r) => (late = r)) };
  const live = scripted((m) => (m === 'chats.recent' ? { chats: [chat('live1'), chat('live2')] } : undefined), online);
  live.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: live.runtime, lists: Promise.resolve(slow as any) })));
  await flush();
  const rows = () => [...host.querySelectorAll('button[aria-label^="Open chat"]')].map((b) => b.getAttribute('aria-label'));
  assert.deepEqual(rows(), ['Open chat Chat live1', 'Open chat Chat live2']);
  await act(async () => late([chat('old')]));
  await flush();
  assert.deepEqual(rows(), ['Open chat Chat live1', 'Open chat Chat live2'], 'the saved list does not replace the live one');
  await act(async () => root.unmount());
  host.remove();

  // the screen goes before the saved list is read
  const gone = scripted(() => undefined, { ...paired, phase: 'ready', selectedPair: null });
  gone.runtime.start = async () => {};
  const host2 = document.createElement('div');
  document.body.append(host2);
  const root2 = createRoot(host2);
  await act(async () => root2.render(createElement(MobileApp, { runtime: gone.runtime, lists: Promise.resolve(slow as any) })));
  await flush();
  await act(async () => root2.unmount());
  host2.remove();
  await act(async () => late([chat('after')]));
});

test('a list store that will not open leaves the app as it was', async () => {
  const s = scripted(() => undefined, { ...paired, phase: 'ready', selectedPair: null });
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, lists: Promise.reject(new Error('disk')) })));
  await flush();
  assert.equal(host.querySelectorAll('button[aria-label^="Open chat"]').length, 0);
  await act(async () => root.unmount());
  host.remove();
});

test('the Mac’s chats.changed reads the list again in place, once for a burst; other events and an away computer change nothing', async () => {
  let live = [chat('a')];
  const s = scripted((m) => (m === 'chats.recent' ? { chats: live } : undefined), online);
  s.runtime.start = async () => {};
  const listeners = new Set<(e: any) => void>();
  s.runtime.onEvent = (f: (e: any) => void) => (listeners.add(f), () => listeners.delete(f));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  const rows = () => [...host.querySelectorAll('button[aria-label^="Open chat"]')].map((b) => b.getAttribute('aria-label'));
  const reads = () => s.calls.filter(([m]) => m === 'chats.recent').length;
  assert.deepEqual(rows(), ['Open chat Chat a']);
  const first = reads();
  live = [chat('a'), chat('b')];
  const emit = (e: any) => act(async () => listeners.forEach((f) => f(e)));
  await emit({ kind: 'event', ev: 'session.patch', chatId: 'a' });
  await emit({ kind: 'event', ev: 'chats.changed' });
  await emit({ kind: 'event', ev: 'chats.changed' });
  await emit({ kind: 'event', ev: 'chats.changed' });
  await new Promise((r) => setTimeout(r, LIST_REREAD_MS + 150));
  await flush();
  assert.equal(reads(), first + 1, 'one read for the burst, none for an event that is not about the list');
  assert.deepEqual(rows(), ['Open chat Chat a', 'Open chat Chat b'], 'the new chat is on screen without a pull');
  // an away computer is not read
  s.state.snap = { ...online, phase: 'offline' };
  await emit({ kind: 'event', ev: 'chats.changed' });
  await new Promise((r) => setTimeout(r, LIST_REREAD_MS + 100));
  assert.equal(reads(), first + 1);
  await act(async () => root.unmount());
  host.remove();
});

test('a burst still waiting when the list goes away is dropped', async () => {
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [chat('a')] } : undefined), online);
  s.runtime.start = async () => {};
  const listeners = new Set<(e: any) => void>();
  s.runtime.onEvent = (f: (e: any) => void) => (listeners.add(f), () => listeners.delete(f));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  const before = s.calls.filter(([m]) => m === 'chats.recent').length;
  await act(async () => listeners.forEach((f) => f({ kind: 'event', ev: 'chats.changed' })));
  await act(async () => root.unmount());
  host.remove();
  await new Promise((r) => setTimeout(r, LIST_REREAD_MS + 100));
  assert.equal(s.calls.filter(([m]) => m === 'chats.recent').length, before, 'nothing is read for a screen that is gone');
  assert.equal(listeners.size, 0);
});

test('the re-read for chats.changed asks for as many chats as are shown, so the pages already loaded stay', async () => {
  const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => chat(`c${from + i}`));
  const s = scripted(
    (m, p) =>
      m === 'chats.recent'
        ? p.offset
          ? { chats: many(50, 10), more: false }
          : { chats: many(0, Math.min(p.limit, 60)), more: p.limit < 60 }
        : undefined,
    online,
  );
  s.runtime.start = async () => {};
  const listeners = new Set<(e: any) => void>();
  s.runtime.onEvent = (f: (e: any) => void) => (listeners.add(f), () => listeners.delete(f));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  await click('Load more chats');
  await flush();
  const limits = () => s.calls.filter(([m]) => m === 'chats.recent').map(([, p]) => p.limit);
  await act(async () => listeners.forEach((f) => f({ kind: 'event', ev: 'chats.changed' })));
  await new Promise((r) => setTimeout(r, LIST_REREAD_MS + 150));
  await flush();
  assert.equal(limits().at(-1), 60, 'the read after the event is as long as the list on screen');
  await act(async () => root.unmount());
  host.remove();
});
