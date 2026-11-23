// A dev-host build pairs from `${edition.scheme}://pair?code=...` so a script can pair an emulator without typing; any other build ignores the link.
import edition from '../mobile/config/edition.json' with { type: 'json' };
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/phone/register.ts';
const corePath = '../mobile/src/devPairLink';
const bindingPath = '../mobile/src/platform/devPairLink';
const { pairingCodeOf, expired, watchDevPairLink } = await import(corePath);
const { startDevPairLink } = await import(bindingPath);
const CODE = '{"v":3,"relay":"ws://10.0.2.2:8787/v1/ws","code":"a/b+c=","exp":2000000000000}';
const NOW = 1_000_000_000_000;
const link = (code: string) => `${edition.scheme}://pair?code=${encodeURIComponent(code)}`;
const READY = { user: { id: 'u' }, phase: 'ready', pendingPair: false, pairCleanup: false, pairingCommit: false };

function fakeLinks(initial: string | null = null, failInitial = false) {
  const listeners = new Set<(e: { url: string }) => void>();
  return {
    listeners,
    links: {
      getInitialURL: () => (failInitial ? Promise.reject(new Error('no link')) : Promise.resolve(initial)),
      addEventListener: (_type: 'url', listener: (e: { url: string }) => void) => {
        listeners.add(listener);
        return { remove: () => void listeners.delete(listener) };
      },
    },
    emit: (url: string) => listeners.forEach((l) => l({ url })),
  };
}
/** A runtime whose snapshot a test changes; `pair` stays pending until a test settles it. */
function fakeRuntime(initial: object = READY) {
  const state = { snap: { ...READY, ...initial } as any };
  const pairs: Array<[string, string]> = [];
  const listeners = new Set<() => void>();
  const pending: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  return {
    pairs,
    pending,
    listeners,
    set: (patch: object) => {
      state.snap = { ...state.snap, ...patch };
      listeners.forEach((l) => l());
    },
    runtime: {
      snapshot: () => state.snap,
      subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
      pair: (code: string, name: string) => {
        pairs.push([code, name]);
        return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
      },
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const options = (over: object = {}) => ({ now: () => NOW, report: () => {}, ...over });

test('the code is read from a pairing link and from nothing else', () => {
  assert.equal(pairingCodeOf(link(CODE)), CODE);
  for (const other of [
    null,
    undefined,
    '',
    'mopilot://chat?id=1',
    'https://example.test/pair?code=x',
    `${edition.scheme}://pair?code=`,
    `${edition.scheme}://pair?code=%E0%A4%A`,
  ])
    assert.equal(pairingCodeOf(other as any), null, String(other));
});

test('a code is expired only when it says so', () => {
  assert.equal(expired(CODE, NOW), false);
  assert.equal(expired(CODE, 3_000_000_000_000), true);
  assert.equal(expired('{"v":3}', NOW), false);
  assert.equal(expired('not json', NOW), false);
});

test('a build with a dev host pairs from the link that opened it and from links that arrive later', async () => {
  const f = fakeLinks(link(CODE));
  const r = fakeRuntime();
  const stop = watchDevPairLink(r.runtime, 'sdk_gphone64_arm64', true, f.links, options());
  await settle();
  assert.deepEqual(r.pairs, [[CODE, 'sdk_gphone64_arm64']]);
  r.pending[0].resolve();
  await settle();
  const second = CODE.replace('a/b+c=', 'second');
  f.emit(link(second));
  f.emit('mopilot://chat?id=1');
  assert.deepEqual(r.pairs.at(-1), [second, 'sdk_gphone64_arm64']);
  assert.equal(r.pairs.length, 2, 'a link that is not a pairing link does nothing');
  stop();
  assert.equal(f.listeners.size, 0);
  assert.equal(r.listeners.size, 0);
  f.emit(link(CODE));
  assert.equal(r.pairs.length, 2, 'nothing is paired after the app stops watching');
});

test('a store build listens to no link at all', async () => {
  const f = fakeLinks(link(CODE));
  const r = fakeRuntime();
  watchDevPairLink(r.runtime, 'Pixel', false, f.links, options())();
  await settle();
  assert.equal(f.listeners.size, 0);
  assert.equal(r.listeners.size, 0);
  assert.deepEqual(r.pairs, []);
});

test('a cold start waits until the account is read and the runtime is idle', async () => {
  const f = fakeLinks(link(CODE));
  const r = fakeRuntime({ user: null, phase: 'loading' });
  watchDevPairLink(r.runtime, 'Pixel', true, f.links, options());
  await settle();
  assert.deepEqual(r.pairs, [], 'signed out and still loading');
  r.set({ user: { id: 'u' }, phase: 'signedOut' });
  assert.deepEqual(r.pairs, [], 'a signed-out phone pairs nothing');
  for (const busy of [{ pendingPair: true }, { pairCleanup: true }, { pairingCommit: true }, { phase: 'pairing' }]) {
    r.set({ ...READY, ...busy });
    assert.deepEqual(r.pairs, [], JSON.stringify(busy));
  }
  r.set(READY);
  assert.deepEqual(r.pairs, [[CODE, 'Pixel']]);
});

test('one pairing runs at a time, the newest waiting code wins, and a failure is reported once and lets the next run', async () => {
  const f = fakeLinks();
  const r = fakeRuntime();
  const reports: string[] = [];
  watchDevPairLink(r.runtime, 'Pixel', true, f.links, options({ report: (m: string) => reports.push(m) }));
  const code = (n: number) => CODE.replace('a/b+c=', `c${n}`);
  f.emit(link(code(1)));
  f.emit(link(code(2)));
  f.emit(link(code(3)));
  assert.deepEqual(
    r.pairs.map(([c]) => c),
    [code(1)],
    'the first is running; the others wait',
  );
  r.pending[0].reject(new Error('invalid or expired QR'));
  await settle();
  assert.deepEqual(reports, ['pairing link: invalid or expired QR']);
  assert.deepEqual(
    r.pairs.map(([c]) => c),
    [code(1), code(3)],
    'the newest waiting code runs next, the one it replaced never does',
  );
  r.pending[1].reject('refused');
  await settle();
  assert.deepEqual(reports.at(-1), 'pairing link: refused');
});

test('an expired code is reported and dropped, a link after the watch stopped is ignored, and a failing initial read changes nothing', async () => {
  const reports: string[] = [];
  const stale = fakeLinks(link(CODE));
  const staleRuntime = fakeRuntime();
  watchDevPairLink(
    staleRuntime.runtime,
    'Pixel',
    true,
    stale.links,
    options({ now: () => 3_000_000_000_000, report: (m: string) => reports.push(m) }),
  );
  await settle();
  assert.deepEqual(staleRuntime.pairs, []);
  assert.deepEqual(reports, ['pairing link: the code has expired']);

  const late = fakeLinks();
  const lateRuntime = fakeRuntime();
  const stop = watchDevPairLink(lateRuntime.runtime, 'Pixel', true, late.links, options());
  const [listener] = [...late.listeners];
  stop();
  listener({ url: link(CODE) });
  assert.deepEqual(lateRuntime.pairs, []);

  const broken = fakeLinks(null, true);
  watchDevPairLink(fakeRuntime().runtime, 'Pixel', true, broken.links, options());
  await settle();
});

test('a link that opened the app is handled once per process: a reload does not replay it', async () => {
  const f = fakeLinks(link(CODE));
  const r = fakeRuntime();
  watchDevPairLink(r.runtime, 'Pixel', true, f.links, options({ skipInitial: true }));
  await settle();
  assert.deepEqual(r.pairs, []);
  f.emit(link(CODE));
  assert.equal(r.pairs.length, 1, 'a link that arrives while the app runs still pairs');
});

test('the binding hands React Native’s Linking to the watch, and replays the opening link once', async () => {
  const g = globalThis as any;
  g.__phoneInitialUrl = link(CODE);
  const r = fakeRuntime();
  const stop = startDevPairLink(r.runtime, 'Pixel', true);
  await settle();
  assert.deepEqual(r.pairs, [[CODE, 'Pixel']]);
  assert.equal(g.__phoneLinkListeners.length, 1);
  stop();
  assert.equal(g.__phoneLinkListeners.length, 0);
  const again = fakeRuntime();
  startDevPairLink(again.runtime, 'Pixel', true)();
  await settle();
  assert.deepEqual(again.pairs, [], 'the second mount of the app in this process does not replay it');
  const store = fakeRuntime();
  startDevPairLink(store.runtime, 'Pixel', false)();
  assert.deepEqual(store.pairs, []);
  delete g.__phoneInitialUrl;
});
