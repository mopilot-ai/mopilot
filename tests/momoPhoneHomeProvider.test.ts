// The phone's copy of MoMo's home for the screens below: opened only when asked (or when something was kept before), watched while open, and forgotten with its account or computer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const cachePath = '../mobile/src/momoPhone/homeCache';
const providerPath = '../mobile/src/screens/momoPhone/HomeCacheProvider';
const { createHomeCache } = await import(cachePath);
const { MomoHomeCacheProvider, HomeCacheContext } = await import(providerPath);

type Any = any;
const consume = (f: (access: Any) => Any) => createElement(HomeCacheContext.Consumer as Any, null, f as Any);
const AT = { user: 'u1', pair: 'p1' };

function memory() {
  let raw: string | null = null;
  const xor = (bytes: Uint8Array) => bytes.map((b) => b ^ 0x5a);
  const cache = createHomeCache({
    store: { read: async () => raw, write: async (v: string) => void (raw = v), clear: async () => void (raw = null) },
    crypto: {
      key: async () => new Uint8Array(32),
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
        xor(new Uint8Array([...new TextEncoder().encode(`${aad}|`), ...plain])),
      open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
        const text = new TextDecoder().decode(xor(box));
        return text.startsWith(`${aad}|`) ? new TextEncoder().encode(text.slice(aad.length + 1)) : null;
      },
    },
  });
  return { cache, raw: () => raw };
}

function runtimeOf(user: string | null, pairs: string[], phase = 'online') {
  const state = { phase, user: user ? { id: user } : null, pairs: pairs.map((pairId) => ({ pairId })) as Any, list: new Set<() => void>() };
  return {
    state,
    runtime: { snapshot: () => state, subscribe: (l: () => void) => (state.list.add(l), () => void state.list.delete(l)) },
    change: async (user2: string | null, pairs2?: string[]) => {
      state.user = user2 ? { id: user2 } : null;
      if (pairs2) state.pairs = pairs2.map((pairId) => ({ pairId }));
      for (const l of [...state.list]) l();
      await flush();
    },
  };
}

test('the provider opens nothing until it is asked, unless something was kept before; then it forgets what is gone', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const m = memory();
  await m.cache.save(AT, { notes: [], turns: [] });
  let opens = 0;
  const open = async () => (opens++, m.cache);
  let used = false;
  const r = runtimeOf('u1', ['p1']);
  const draw = (extra: Any = {}) =>
    act(async () =>
      root.render(
        createElement(
          MomoHomeCacheProvider as Any,
          { runtime: r.runtime as Any, open, wasUsed: async () => used, mark: async () => (used = true), ...extra },
          consume((access: Any) => {
            seen.access = access;
            return createElement('span', null, 'child');
          }),
        ),
      ),
    );
  const seen: Any = {};
  await draw();
  await flush();
  assert.equal(host.textContent, 'child');
  assert.equal(opens, 0, 'a phone where MoMo’s home was never used opens no database');
  await act(async () => root.unmount());
  // something was kept: the launch opens it and forgets what belongs to an account that signed out
  used = true;
  const again = createRoot(host);
  await act(async () =>
    again.render(
      createElement(
        MomoHomeCacheProvider as Any,
        { runtime: r.runtime as Any, open, wasUsed: async () => used, mark: async () => undefined },
        createElement('span', null, 'x'),
      ),
    ),
  );
  await flush();
  assert.equal(opens, 1);
  await r.change(null, []);
  assert.equal(m.raw(), null);
  await act(async () => again.unmount());
  host.remove();
});

test('the copy is opened on the first ask and once; a copy that will not open is none; forgetting a computer waits for a copy that exists', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const m = memory();
  await m.cache.save(AT, { notes: [], turns: [] });
  let opens = 0;
  let used = false;
  let fail = false;
  const open = async () => {
    opens++;
    if (fail) throw new Error('storage unavailable');
    return m.cache;
  };
  const r = runtimeOf('u1', ['p1']);
  const seen: Any = {};
  await act(async () =>
    root.render(
      createElement(
        MomoHomeCacheProvider as Any,
        { runtime: r.runtime as Any, open, wasUsed: async () => used, mark: async () => (used = true) },
        consume((access: Any) => ((seen.access = access), null)),
      ),
    ),
  );
  await seen.access.forgetScope(AT);
  assert.deepEqual([opens, (await m.cache.scopes()).length], [0, 1], 'nothing was ever kept: nothing to forget');
  const [one, two] = await Promise.all([seen.access.get(), seen.access.get()]);
  assert.deepEqual([opens, one === two], [1, true]);
  await seen.access.mark();
  assert.equal(used, true);
  await seen.access.forgetScope(AT);
  assert.equal((await m.cache.scopes()).length, 0);
  await act(async () => root.unmount());
  fail = true;
  const failing = createRoot(host);
  const s2: Any = {};
  await act(async () =>
    failing.render(
      createElement(
        MomoHomeCacheProvider as Any,
        { runtime: r.runtime as Any, open, wasUsed: async () => true, mark: async () => undefined },
        consume((access: Any) => ((s2.access = access), null)),
      ),
    ),
  );
  assert.equal(await s2.access.get(), null);
  await s2.access.forgetScope(AT);
  assert.equal(
    await (async () => {
      used = false;
      return s2.access.forgetScope(AT);
    })(),
    undefined,
  );
  await act(async () => failing.unmount());
  // a copy that cannot be read of "was it used" counts as unused
  const broken = createRoot(host);
  const s3: Any = {};
  await act(async () =>
    broken.render(
      createElement(
        MomoHomeCacheProvider as Any,
        {
          runtime: r.runtime as Any,
          open,
          wasUsed: async () => {
            throw new Error('keychain');
          },
          mark: async () => undefined,
        },
        consume((access: Any) => ((s3.access = access), null)),
      ),
    ),
  );
  await s3.access.forgetScope(AT);
  await act(async () => broken.unmount());
  // closed before the copy opened: nothing is watched
  const late = createRoot(host);
  let release: (c: Any) => void = () => undefined;
  const slowOpen = () => new Promise<Any>((resolve) => (release = resolve));
  await act(async () =>
    late.render(
      createElement(
        MomoHomeCacheProvider as Any,
        { runtime: r.runtime as Any, open: slowOpen, wasUsed: async () => true, mark: async () => undefined },
        createElement('span', null, 'x'),
      ),
    ),
  );
  await flush();
  await act(async () => late.unmount());
  release(m.cache);
  await flush();
  assert.equal(r.state.list.size, 0);
  host.remove();
});

test('the lease the phone has seen is read once per account, from the copy, and shared by every computer of it', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const m = memory();
  await m.cache.keepStamp('u1', { homeId: 'mini', leaseEpoch: 4 });
  let opens = 0;
  const r = runtimeOf('u1', ['p1']);
  const seen: Any = {};
  await act(async () =>
    root.render(
      createElement(
        MomoHomeCacheProvider as Any,
        { runtime: r.runtime as Any, open: async () => (opens++, m.cache), wasUsed: async () => true, mark: async () => undefined },
        consume((access: Any) => ((seen.access = access), null)),
      ),
    ),
  );
  await flush();
  const [a, b] = await Promise.all([seen.access.stamps('u1'), seen.access.stamps('u1')]);
  assert.equal(a, b);
  assert.equal(opens, 1);
  const stamped = (homeMachineId: string, leaseEpoch: number) => ({ view: { home: { homeMachineId, leaseEpoch } }, now: 1, waking: false });
  assert.equal(a.view(stamped('studio', 3)), false);
  assert.equal(a.view(stamped('mini', 4)), true);
  await act(async () => root.unmount());
  host.remove();
});
