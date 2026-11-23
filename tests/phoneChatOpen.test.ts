// Opening a chat: chat.follow leaves first, the header and cached rows paint at once with no "Loading chat…", and the rest of the reads go out together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, openComputer } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const appPath = '../mobile/src/MobileApp';
const cachePath = '../mobile/src/presentation/threadCache';
const keyPath = '../mobile/src/presentation/drafts';
const { MobileApp } = await import(appPath);
const { rememberRows, forgetRows } = await import(cachePath);
const { draftKey } = await import(keyPath);

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
const live = {
  rev: 1,
  feedSeq: 0,
  session: { turn: 'idle', cards: [] },
  itemsShape: 'rows',
  items: [{ role: 'assistant', text: 'Fresh from the Mac' }],
};

async function open(cache: boolean, release: { done?: (v: unknown) => void } = {}) {
  forgetRows();
  if (cache) rememberRows(draftKey('u', 'p', 'c1'), [{ key: 'old', role: 'assistant', text: 'Cached earlier answer' }]);
  const s = scripted(
    (m) =>
      m === 'chats.recent'
        ? { chats: [{ id: 'c1', title: 'Build' }] }
        : m === 'chat.follow'
          ? new Promise((resolve) => (release.done = () => resolve(live)))
          : undefined,
    online,
  );
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  const before = s.calls.length;
  await click('Open chat Build');
  return { s, host, root, before };
}

test('chat.follow is the first request of an open, and the others go out without waiting on each other', async () => {
  const release: { done?: (v: unknown) => void } = {};
  const { s, host, root, before } = await open(false, release);
  const sent = s.calls.slice(before).map(([m]) => m);
  assert.equal(sent[0], 'chat.follow', `first request was ${sent[0]}: ${sent.join(', ')}`);
  assert.ok(sent.filter((m) => m === 'machine.hello').length <= 1, `hello once: ${sent.join(', ')}`);
  release.done?.(live);
  await flush();
  await act(async () => root.unmount());
  host.remove();
});

test('the chat paints before the Mac answers: no loading text, the rows last seen, then the fresh ones in their place', async () => {
  const release: { done?: (v: unknown) => void } = {};
  const { host, root } = await open(true, release);
  assert.doesNotMatch(host.textContent!, /Loading chat/);
  assert.match(host.textContent!, /Cached earlier answer/);
  release.done?.(live);
  await flush();
  assert.match(host.textContent!, /Fresh from the Mac/);
  assert.doesNotMatch(host.textContent!, /Cached earlier answer/, 'a stale cache never sits beside newer content');
  await act(async () => root.unmount());
  host.remove();
});

test('a chat never opened shows no loading text either', async () => {
  const release: { done?: (v: unknown) => void } = {};
  const { host, root } = await open(false, release);
  assert.doesNotMatch(host.textContent!, /Loading chat/);
  await act(async () => root.unmount());
  host.remove();
});

const sealedPath = '../mobile/src/presentation/chatCache';
const { createChatCache, boundRows, CACHE_BYTES, CACHE_ROW_CHARS } = await import(sealedPath);
const { CACHE_CHATS, CACHE_ROWS, recentRows } = await import(cachePath);

function deferredKey() {
  let resolve!: (k: Uint8Array) => void;
  const promise = new Promise<Uint8Array>((r) => (resolve = r));
  return { promise, resolve };
}
function fakeCache() {
  const disk = new Map<string, string>();
  const order: string[] = [];
  const touch = (k: string) => (order.includes(k) && order.splice(order.indexOf(k), 1), order.push(k));
  const store = {
    read: async (k: string) => disk.get(k) ?? null,
    write: async (k: string, v: string) => (disk.set(k, v), touch(k), undefined),
    remove: async (k: string) => (disk.delete(k), order.includes(k) && order.splice(order.indexOf(k), 1), undefined),
    keys: async () => [...order],
    clear: async () => (disk.clear(), order.splice(0), undefined),
  };
  const crypto = {
    key: async () => new Uint8Array([7]),
    randomBytes: (n: number) => new Uint8Array(n).fill(3),
    // a stand-in cipher that binds the aad, as the real AEAD does
    seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
      new TextEncoder().encode(`${aad}\u0000${new TextDecoder().decode(plain)}`),
    open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
      const text = new TextDecoder().decode(box);
      return text.startsWith(`${aad}\u0000`) ? new TextEncoder().encode(text.slice(aad.length + 1)) : null;
    },
  };
  const cache = createChatCache({ store, crypto });
  return { cache: Object.assign(cache, { __store: store, __crypto: crypto }), disk };
}
const row = (i: number, text = `r${i}`) => ({
  key: `k${i}`,
  role: 'assistant',
  text,
});

test('the sealed cache round-trips, is bound to its key, and holds no plain text on disk', async () => {
  const { cache, disk } = fakeCache();
  await cache.save('a', [row(1, 'secret words')]);
  assert.deepEqual(await cache.load('a'), [row(1, 'secret words')]);
  assert.doesNotMatch(disk.get('a')!, /secret words/);
  disk.set('b', disk.get('a')!);
  assert.deepEqual(await cache.load('b'), [], 'a sealed row moved under another key does not open');
  assert.deepEqual(await cache.load('none'), []);
  disk.set('bad', 'not json');
  assert.deepEqual(await cache.load('bad'), []);
  await cache.save('a', []);
  assert.deepEqual(await cache.load('a'), [], 'a chat with no rows keeps no old ones');
});

test('the cache is bounded: rows, text and chats', async () => {
  const many = Array.from({ length: CACHE_ROWS + 20 }, (_, i) => row(i));
  assert.equal(boundRows(many).length, CACHE_ROWS);
  assert.equal(boundRows(many).at(-1)!.text, `r${CACHE_ROWS + 19}`);
  assert.equal(boundRows([row(1, 'x'.repeat(CACHE_ROW_CHARS * 3))])[0].text.length, CACHE_ROW_CHARS);
  const big = Array.from({ length: 40 }, (_, i) => row(i, 'y'.repeat(CACHE_ROW_CHARS)));
  const kept = boundRows(big);
  assert.ok(kept.reduce((n: number, r: { text: string }) => n + r.text.length, 0) <= CACHE_BYTES);
  assert.equal(kept.at(-1)!.key, 'k39', 'the newest rows are the ones kept');
  const { cache } = fakeCache();
  for (let i = 0; i < CACHE_CHATS + 3; i++) await cache.save(`c${i}`, [row(i)]);
  assert.deepEqual(await cache.load('c0'), []);
  assert.equal((await cache.load(`c${CACHE_CHATS + 2}`)).length, 1);
});

test('sign-out and unpair clear the sealed copy; prune and remove drop what the computer no longer has', async () => {
  const { cache } = fakeCache();
  await cache.save('x', [row(1)]);
  await cache.save('y', [row(2)]);
  await cache.save('z', [row(3)]);
  await cache.remove('x');
  assert.deepEqual(await cache.load('x'), []);
  await cache.prune((k: string) => k === 'y');
  assert.deepEqual(await cache.load('z'), []);
  assert.equal((await cache.load('y')).length, 1);
  await cache.clear();
  assert.deepEqual(await cache.load('y'), []);
});

test('the open chat saves its rows sealed, paints from them next time, and a chat the Mac refuses as gone is cleared', async () => {
  const { cache } = fakeCache();
  const key = draftKey('u', 'p', 'c1');
  await cache.save(key, [{ key: 'disk1', role: 'assistant', text: 'From the sealed copy' }]);
  forgetRows();
  const s = scripted(
    (m) => (m === 'chats.recent' ? { chats: [{ id: 'c1', title: 'Build' }] } : m === 'chat.follow' ? new Promise(() => {}) : undefined),
    online,
  );
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(MobileApp, {
        runtime: s.runtime,
        rows: Promise.resolve(cache),
      }),
    ),
  );
  await flush();
  await click('Open chat Build');
  await flush();
  assert.match(host.textContent!, /From the sealed copy/, 'painted from disk while the Mac has not answered');
  await act(async () => root.unmount());
  host.remove();

  // the Mac says the chat is gone: memory and disk are cleared
  forgetRows();
  await cache.save(key, [{ key: 'disk1', role: 'assistant', text: 'Gone chat text' }]);
  const gone = scripted(
    (m) =>
      m === 'chats.recent'
        ? { chats: [{ id: 'c1', title: 'Build' }] }
        : m === 'chat.follow'
          ? Promise.reject(new Error('Chat not found'))
          : undefined,
    online,
  );
  gone.runtime.start = async () => {};
  const host2 = document.createElement('div');
  document.body.append(host2);
  const root2 = createRoot(host2);
  await act(async () =>
    root2.render(
      createElement(MobileApp, {
        runtime: gone.runtime,
        rows: Promise.resolve(cache),
      }),
    ),
  );
  await flush();
  await click('Open chat Build');
  await flush();
  await flush();
  assert.deepEqual(await cache.load(key), []);
  assert.deepEqual(recentRows(key), []);
  await act(async () => root2.unmount());
  host2.remove();
});

test('a chat the fresh list no longer holds is dropped from the sealed copy', async () => {
  const { cache } = fakeCache();
  await cache.save(draftKey('u', 'p', 'kept'), [row(1)]);
  await cache.save(draftKey('u', 'p', 'deleted'), [row(2)]);
  rememberRows(draftKey('u', 'p', 'kept'), [row(1)]);
  rememberRows(draftKey('u', 'p', 'deleted'), [row(2)]);
  await cache.save(draftKey('u', 'other', 'elsewhere'), [row(3)]);
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [{ id: 'kept', title: 'Kept' }] } : undefined), online);
  s.runtime.start = async () => {};
  s.runtime.signOut = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(MobileApp, {
        runtime: s.runtime,
        rows: Promise.resolve(cache),
      }),
    ),
  );
  await flush();
  await flush();
  assert.equal((await cache.load(draftKey('u', 'p', 'kept'))).length, 1);
  assert.deepEqual(await cache.load(draftKey('u', 'p', 'deleted')), [], 'deleted on the Mac');
  assert.deepEqual(recentRows(draftKey('u', 'p', 'deleted')), [], 'and from memory');
  assert.equal(recentRows(draftKey('u', 'p', 'kept')).length, 1, 'a chat the list still holds stays');
  assert.equal((await cache.load(draftKey('u', 'other', 'elsewhere'))).length, 1, 'another computer is left alone');
  await act(async () => root.unmount());
  host.remove();
});

test('signing out and removing a computer clear the sealed copy (the removed computer only for removal)', async () => {
  const away = {
    ...online,
    phase: 'offline',
    selectedPair: null,
    pairs: [{ pairId: 'p', macId: 'm', name: 'Mac' }],
  };
  for (const how of ['signOut', 'unpair']) {
    const { cache } = fakeCache();
    await cache.save(draftKey('u', 'p', 'c1'), [row(1)]);
    await cache.save(draftKey('u', 'q', 'c2'), [row(2)]);
    forgetRows();
    const s = scripted(() => undefined, away);
    s.runtime.start = async () => {};
    s.runtime.signOut = async () => {};
    s.runtime.unpair = async () => {};
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(MobileApp, {
          runtime: s.runtime,
          rows: Promise.resolve(cache),
        }),
      ),
    );
    await flush();
    await click('Settings');
    if (how === 'signOut') {
      await click('Sign out');
      await click('Confirm sign out');
      await flush();
      assert.deepEqual(await cache.load(draftKey('u', 'p', 'c1')), []);
      assert.deepEqual(await cache.load(draftKey('u', 'q', 'c2')), [], 'every chat goes with the account');
    } else {
      await openComputer();
      await click('Remove computer');
      await click('Remove');
      await flush();
      assert.deepEqual(await cache.load(draftKey('u', 'p', 'c1')), [], "the removed computer's chats go");
      assert.equal((await cache.load(draftKey('u', 'q', 'c2'))).length, 1, "another computer's stay");
    }
    await act(async () => root.unmount());
    host.remove();
  }
});

test('a save that began before a sign-out or removal cannot write after it', async () => {
  const { cache } = fakeCache();
  const gate = deferredKey();
  const late = createChatCache({ store: cache.__store, crypto: { ...cache.__crypto, key: () => gate.promise } });
  const pending = late.save('a', [row(1)]);
  await late.clear();
  gate.resolve(new Uint8Array([7]));
  await pending;
  assert.deepEqual(await late.load('a'), [], 'the late save found the cache cleared and stopped');
});

test('only a refusal that names the chat clears it', async () => {
  const rowsPath = '../mobile/src/remote/useChatRows';
  const { forgetIfGone } = await import(rowsPath);
  const { cache } = fakeCache();
  const key = draftKey('u', 'p', 'c1');
  for (const [message, gone] of [
    ['Chat not found', true],
    ["That chat isn't in MoPilot.", true],
    ['That chat isn’t in MoPilot.', true],
    ["That chat isn't in MoPilot Code.", true],
    ['That chat isn’t in MoPilot Code.', true],
    ["That chat isn't in MoPilot Codex.", false],
    ["That chat isn't in MoPilot Codeboard.", false],
    ['That project isn’t in MoPilot Code.', false],
    ['pair not found', false],
    ['relay: route not found', false],
    ['Request timed out', false],
  ] as const) {
    rememberRows(key, [row(1)]);
    await cache.save(key, [row(1)]);
    forgetIfGone(message, key, cache);
    await flush();
    assert.equal((await cache.load(key)).length, gone ? 0 : 1, message);
    assert.equal(recentRows(key).length, gone ? 0 : 1, message);
  }
});

test('the cache finishing its open mid-chat does not follow the chat again', async () => {
  const { cache } = fakeCache();
  let open!: (c: unknown) => void;
  const late = new Promise((resolve) => (open = resolve));
  forgetRows();
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [{ id: 'c1', title: 'Build' }] } : undefined), online);
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime, rows: late })));
  await flush();
  await click('Open chat Build');
  await flush();
  await act(async () => open(cache));
  await flush();
  assert.equal(s.calls.filter(([m]) => m === 'chat.follow').length, 1, 'one follow, however late the cache opens');
  assert.equal(s.calls.filter(([m]) => m === 'chat.unfollow').length, 0);
  await act(async () => root.unmount());
  host.remove();
});

test('a follow the runtime refuses at once is a rejection; a queued follow goes after the one ahead and is refused if the computer changed meanwhile', async () => {
  const followPath = '../mobile/src/presentation/follow';
  const { followRequest } = await import(followPath);
  const snap = { selectedPair: 'p', generation: 1 };
  const sent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let refuse = true;
  const runtime: any = {
    snapshot: () => ({ ...snap }),
    request: (m: string) => {
      if (refuse) throw new Error('Connect to a computer first');
      sent.push(m);
      return sent.length === 1 ? gate.then(() => ({})) : Promise.resolve({});
    },
  };
  await assert.rejects(followRequest(runtime, 'c1', 'chat.follow'), /Connect to a computer first/);
  refuse = false;
  const first = followRequest(runtime, 'c1', 'chat.follow');
  const second = followRequest(runtime, 'c1', 'chat.unfollow');
  snap.generation = 2;
  release();
  await first;
  await assert.rejects(second, /computer changed/);
  assert.deepEqual(sent, ['chat.follow']);
});

test('removing a computer forgets its chats in memory, and the chat ids kept are listed per account and computer', async () => {
  const { forgetPairRows, recentChatIds } = await import(cachePath);
  forgetRows();
  rememberRows(draftKey('u', 'p', 'c1'), [row(1)]);
  rememberRows(draftKey('u', 'q', 'c2'), [row(2)]);
  assert.deepEqual(recentChatIds(`${JSON.stringify(['u', 'p']).slice(0, -1)},`), ['c1']);
  forgetPairRows('p');
  assert.deepEqual(recentRows(draftKey('u', 'p', 'c1')), []);
  assert.equal(recentRows(draftKey('u', 'q', 'c2')).length, 1);
});

test('a sealed row that opens to something other than rows reads as none, and a cache that fails to open leaves the app as it was', async () => {
  const { cache, disk } = fakeCache();
  await cache.save('a', [row(1)]);
  const stored = disk.get('a')!;
  disk.set('a', stored.replace(/"box":"[0-9a-f]+"/, `"box":"${Buffer.from('chat-rows:a\u0000{"not":"rows"}').toString('hex')}"`));
  assert.deepEqual(await cache.load('a'), []);
  const s = scripted((m) => (m === 'chats.recent' ? { chats: [{ id: 'c1', title: 'Build' }] } : undefined), online);
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(MobileApp, { runtime: s.runtime, rows: Promise.reject(new Error('storage unavailable')) })),
  );
  await flush();
  assert.ok(host.textContent!.includes('Build'), 'the list still shows without the cache');
  await act(async () => root.unmount());
  host.remove();
});

test('a follow queued behind a refused one still goes; a refusal that is not an Error is shown as text', async () => {
  const followPath = '../mobile/src/presentation/follow';
  const { followRequest } = await import(followPath);
  const sent: string[] = [];
  let first = true;
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    request: (m: string) => {
      sent.push(m);
      if (first) {
        first = false;
        return Promise.reject(new Error('refused'));
      }
      return Promise.resolve({});
    },
  };
  const refused = followRequest(runtime, 'c1', 'chat.follow');
  const next = followRequest(runtime, 'c1', 'chat.follow');
  await assert.rejects(refused, /refused/);
  await next;
  assert.deepEqual(sent, ['chat.follow', 'chat.follow']);

  forgetRows();
  const s = scripted(
    (m) =>
      m === 'chats.recent'
        ? { chats: [{ id: 'c1', title: 'Build' }] }
        : m === 'chat.follow'
          ? Promise.reject('plain text refusal')
          : undefined,
    online,
  );
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  await click('Open chat Build');
  await flush();
  assert.match(host.textContent!, /plain text refusal/);
  await act(async () => root.unmount());
  host.remove();
});

test('without a history key the chat has no rows to paint and keeps none', async () => {
  const hookPath = '../mobile/src/remote/useChatRows';
  const { useChatRows } = await import(hookPath);
  let seen: unknown = null;
  const Probe = () => ((seen = useChatRows(undefined, null, null)), null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  assert.deepEqual(seen, []);
  await act(async () => root.unmount());
  host.remove();
});
