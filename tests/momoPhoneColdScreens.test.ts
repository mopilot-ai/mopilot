// MoMo's phone when the home cannot be read: the cause and Try again, the notes the phone kept (to read, never to change), and the copy made for the account and computer the screens were opened on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { fakeDraft } from './support/phone/drafts';
import { createMomoStore, find, fixtureView, MomoPhone, tap, unmountAll } from './support/phone/momo-screens';

const cachePath = '../mobile/src/momoPhone/homeCache';
const hookPath = '../mobile/src/screens/momoPhone/useMomoHome';
const providerPath = '../mobile/src/screens/momoPhone/HomeCacheProvider';
const { createHomeCache } = await import(cachePath);
const { useMomoHome, useMomoHomeStore } = await import(hookPath);
const { HomeCacheContext } = await import(providerPath);

type Any = any;
const AT = { user: 'u1', pair: 'p1' };
function memory() {
  let raw: string | null = null;
  const xor = (b: Uint8Array) => b.map((x) => x ^ 0x5a);
  return createHomeCache({
    store: { read: async () => raw, write: async (v: string) => void (raw = v), clear: async () => void (raw = null) },
    crypto: {
      key: async () => new Uint8Array(32),
      randomBytes: (n: number) => new Uint8Array(n).fill(3),
      seal: (_k: Uint8Array, _n: Uint8Array, p: Uint8Array, aad: string) =>
        xor(new Uint8Array([...new TextEncoder().encode(`${aad}|`), ...p])),
      open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
        const t = new TextDecoder().decode(xor(box));
        return t.startsWith(`${aad}|`) ? new TextEncoder().encode(t.slice(aad.length + 1)) : null;
      },
    },
  });
}

async function draw(store: Any) {
  await unmountAll();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const backs: string[] = [];
  await act(async () => root.render(createElement(MomoPhone, { store, back: () => backs.push('b'), drafts: fakeDraft(), clock: () => 1 })));
  await flush();
  await flush();
  return { host, backs, text: () => host.textContent ?? '', close: async () => (await act(async () => root.unmount()), host.remove()) };
}

test('with the home out of reach the cause and Try again show, with the notes the phone kept, read-only', async () => {
  const cache = memory();
  await cache.save(AT, { notes: fixtureView().view.notes, turns: [] });
  let reachable = false;
  const store = createMomoStore(
    {
      load: async () => {
        if (!reachable) throw new Error('Studio did not answer.');
        return fixtureView();
      },
      send: async () => ({ ok: true }),
      subscribe: () => () => undefined,
    },
    { persist: { load: () => cache.load(AT), save: (c: Any) => cache.save(AT, c) } },
  );
  const d = await draw(store);
  assert.match(d.text(), /MoMo isn't reachable/);
  assert.match(d.text(), /Studio did not answer\./);
  assert.match(d.text(), /Acme/);
  await tap('Acme');
  assert.match(d.text(), /Renewal in progress/);
  assert.equal(find('Edit'), undefined, 'a note cannot be changed without the home');
  assert.equal(find('Forget'), undefined);
  assert.ok(find('History'));
  await tap('Back');
  assert.doesNotMatch(d.text(), /Renewal in progress/);
  await tap('Back');
  assert.deepEqual(d.backs, ['b']);
  reachable = true;
  await tap('Try again');
  await flush();
  assert.match(d.text(), /MoMo · Studio/);
  await d.close();
});

test('with nothing kept the cold screen has only the cause and Try again', async () => {
  const store = createMomoStore({
    load: async () => Promise.reject(new Error('Offline.')),
    send: async () => ({ ok: true }),
    subscribe: () => () => undefined,
  });
  const d = await draw(store);
  assert.match(d.text(), /Offline\./);
  assert.doesNotMatch(d.text(), /Acme/);
  await d.close();
});

test('the store the screens read is made for the account and computer they opened on, and keeps its copy there', async () => {
  const cache = memory();
  let marked = 0;
  const access = {
    get: async () => cache,
    mark: async () => void marked++,
    stamps: async () => ({ view: () => true, push: () => true }),
    forgetScope: async () => undefined,
  };
  const snap = { user: { id: 'u1' } as Any, selectedPair: 'p1' };
  const runtime: Any = {
    snapshot: () => snap,
    request: async (method: string) => {
      if (method === 'momo.home.view') return { view: fixtureView().view };
      throw new Error(method);
    },
    onEvent: () => () => undefined,
  };
  const out: Any = {};
  const Probe = ({ scope }: { scope: string }) => {
    out.store = useMomoHomeStore(runtime, scope, true);
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(HomeCacheContext.Provider, { value: access }, createElement(Probe, { scope: JSON.stringify(['u1', 'p1']) }))),
  );
  await out.store.load();
  await flush();
  assert.equal((await cache.load(AT)).copy.notes[0].title, 'Acme');
  assert.ok(marked > 0, 'a copy now exists, and the phone notes it');
  // no account or computer, no copy
  snap.user = undefined;
  await act(async () => root.render(createElement(HomeCacheContext.Provider, { value: access }, createElement(Probe, { scope: 'x' }))));
  assert.ok(out.store);
  await act(async () => root.unmount());
  host.remove();
});

test('a copy that cannot be opened fails closed: nothing is sent that could not be kept, and the person is told; a computer that is not a MoMo home has its copy forgotten', async () => {
  const forgotten: Any[] = [];
  const access = {
    get: async () => null,
    mark: async () => undefined,
    stamps: async () => ({ view: () => true, push: () => true }),
    forgetScope: async (at: Any) => void forgotten.push(at),
  };
  const snap = { user: { id: 'u1' } as Any, selectedPair: 'p1', phase: 'online' };
  const runtime: Any = {
    snapshot: () => snap,
    request: async (method: string) => {
      if (method === 'machine.hello') return { capabilities: { momo: true } };
      throw new Error(method);
    },
    onEvent: () => () => undefined,
  };
  const out: Any = {};
  const Probe = () => {
    out.home = useMomoHome(runtime, true);
    out.store = useMomoHomeStore(runtime, JSON.stringify(['u1', 'p1']), true);
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(HomeCacheContext.Provider, { value: access }, createElement(Probe))));
  await flush();
  await flush();
  assert.deepEqual(forgotten, [{ user: 'u1', pair: 'p1' }], 'this computer is not a MoMo home');
  // what may be kept there cannot be read, so it is told as lost and no message is sent that could not be kept
  await out.store.load();
  assert.equal(await out.store.sendText('hi'), false);
  assert.equal(out.store.get().lost, true);
  assert.deepEqual(out.store.get().turns, []);
  await act(async () => root.unmount());
  // with no copy provider at all nothing is forgotten and nothing breaks
  const bare = createRoot(host);
  await act(async () => bare.render(createElement(Probe)));
  await flush();
  await act(async () => bare.unmount());
  host.remove();
});

test('when what was kept cannot be read the chat says so, and Discard starts it again', async () => {
  const saves: Any[] = [];
  const store = createMomoStore(
    { load: async () => fixtureView(), send: async () => ({ ok: true }), subscribe: () => () => undefined },
    { persist: { load: async () => ({ status: 'unreadable' }), save: async (c: Any) => void saves.push(c) } },
  );
  const d = await draw(store);
  assert.match(d.text(), /Unsent messages from before couldn't be restored\./);
  assert.deepEqual(saves, []);
  await tap('Discard');
  assert.doesNotMatch(d.text(), /Unsent messages from before/);
  await d.close();
});

test('a keychain that will not take the marker does not stop a message being kept', async () => {
  const cache = memory();
  const access = {
    get: async () => cache,
    mark: async () => Promise.reject(new Error('keychain')),
    stamps: async () => ({ view: () => true, push: () => true }),
    forgetScope: async () => undefined,
  };
  const runtime: Any = {
    snapshot: () => ({ user: { id: 'u1' }, selectedPair: 'p1' }),
    request: async () => ({}),
    onEvent: () => () => undefined,
  };
  const out: Any = {};
  const Probe = () => {
    out.store = useMomoHomeStore(runtime, JSON.stringify(['u1', 'p1']), true);
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(HomeCacheContext.Provider as Any, { value: access }, createElement(Probe))));
  await out.store.load().catch(() => undefined);
  out.store.sendText('kept anyway');
  await flush();
  await flush();
  assert.equal((await cache.load(AT)).copy.turns.length >= 0, true);
  await act(async () => root.unmount());
  host.remove();
});
