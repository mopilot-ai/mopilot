// Connecting Google runs on this phone: the store runs the sign-in instead of sending the intent, reads the home again after it, and shows a failure with the fix it offers; remove goes to the home. The phone's own run reaches the home's Host through `momo.home.google`.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';

const fixturesPath = '../mobile/src/momoPhone/fixtures';
const storePath = '../mobile/src/momoPhone/store';
const hookPath = '../mobile/src/screens/momoPhone/useMomoHome';
const accessPath = '../mobile/src/momo/useMomoAccess';
const { fixtureView } = await import(fixturesPath);
const { createMomoStore } = await import(storePath);
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const opened: [string, string][] = [];
let dismissed = false;
mock.module(require.resolve('expo-web-browser'), {
  namedExports: {
    openAuthSessionAsync: async (url: string, redirectUri: string) => (
      opened.push([url, redirectUri]), dismissed ? { type: 'dismiss' } : { type: 'success', url: `${redirectUri}?code=c&state=s` }
    ),
  },
});
const asked: { method: string; params: unknown }[] = [];
mock.module('../mobile/src/momo/googleSignIn.ts', {
  namedExports: {
    runGoogleOnPhone: async (o: any) => {
      asked.push({ method: 'run', params: o.intent });
      await o.call('host.momoGoogle', { op: 'status' });
      const seen = await o.openAuthSession('https://accounts.example/auth', 'app://done');
      return seen.type === 'success' ? { ok: true } : { ok: false, cause: 'It did not finish.' };
    },
  },
});
mock.module('../mobile/src/platform/crypto.ts', { namedExports: { phonePrimitives: () => ({}) } });
const { act, createElement, createRoot } = await import('./support/phone/momo-screens');
const { googleOnThisPhone, useMomoHomeStore } = await import(hookPath);

const make = (google: any) => {
  const sent: unknown[] = [];
  let loads = 0;
  const view = fixtureView();
  const transport = {
    async load() {
      loads++;
      return view;
    },
    async send(intent: unknown) {
      sent.push(intent);
      return { ok: true as const };
    },
    subscribe: () => () => undefined,
  };
  const store = createMomoStore(transport as any, { google });
  return { store, sent, loads: () => loads };
};

test('connecting runs on the phone and the home is read again; remove is sent to the home', async () => {
  const ran: string[] = [];
  const m = make(async (intent: string) => (ran.push(intent), { ok: true }));
  await m.store.load();
  const before = m.loads();
  assert.deepEqual(await m.store.act({ kind: 'google', intent: 'reconnect' }), { ok: true });
  assert.deepEqual(ran, ['reconnect']);
  assert.deepEqual(m.sent, []);
  assert.equal(m.loads(), before + 1);
  await m.store.act({ kind: 'google', intent: 'remove' });
  assert.deepEqual(m.sent, [{ kind: 'google', intent: 'remove' }]);
});

test('a sign-in that did not finish says why and offers the fix the home gave', async () => {
  const fixes = [
    { cause: 'Google ended it.', fix: { kind: 'google', intent: 'reconnect', client: 'ios' }, fixLabel: 'Sign in again' },
    { cause: 'Not set up.', fix: { kind: 'google', intent: 'remove', client: 'ios' }, fixLabel: 'Disconnect Google' },
    { cause: 'Odd.', fix: { kind: 'google', intent: 'sideways', client: 'ios' }, fixLabel: 'Do it' },
    { cause: 'Other.', fix: { kind: 'other' }, fixLabel: 'Do it' },
    { cause: 'No label.', fix: { kind: 'google', intent: 'connect', client: 'ios' } },
    { cause: 'Plain.' },
  ];
  const wanted = [
    { kind: 'google', intent: 'reconnect' },
    { kind: 'google', intent: 'remove' },
    undefined,
    undefined,
    undefined,
    undefined,
  ];
  for (const [i, fail] of fixes.entries()) {
    const m = make(async () => ({ ok: false, ...fail }));
    await m.store.load();
    const result: any = await m.store.act({ kind: 'google', intent: 'connect' });
    assert.equal(result.ok, false);
    assert.equal(result.cause, fail.cause);
    assert.deepEqual(result.fix, wanted[i]);
    assert.equal(result.fixLabel, wanted[i] ? fail.fixLabel : undefined);
  }
});

test('without a phone sign-in the intent is sent like any other', async () => {
  const m = make(undefined);
  await m.store.load();
  await m.store.act({ kind: 'google', intent: 'connect' });
  assert.deepEqual(m.sent, [{ kind: 'google', intent: 'connect' }]);
});

test('the phone’s own run reaches the home’s Host through momo.home.google and opens the system’s sign-in session', async () => {
  const calls: [string, unknown][] = [];
  const request = async (method: string, params: Record<string, unknown>) => (calls.push([method, params]), { ok: true });
  assert.deepEqual(await googleOnThisPhone('connect', request), { ok: true });
  assert.deepEqual(calls, [['momo.home.google', { op: 'status' }]]);
  assert.deepEqual(opened, [['https://accounts.example/auth', 'app://done']]);
});

test('a sign-in session the person dismissed is a cancel', async () => {
  dismissed = true;
  const request = async () => ({ ok: true });
  assert.deepEqual(await googleOnThisPhone('grant-send', request), { ok: false, cause: 'It did not finish.' });
  dismissed = false;
});

test('the store of the screen connects Google on this phone through the computer’s channel', async () => {
  const requests: string[] = [];
  const runtime: any = {
    snapshot: () => ({ user: { id: 'u1' }, selectedPair: 'p1', phase: 'online' }),
    request: async (method: string) => (requests.push(method), method === 'momo.home.view' ? { view: fixtureView().view } : { ok: true }),
    onEvent: () => () => undefined,
  };
  const out: any = {};
  const Probe = () => ((out.store = useMomoHomeStore(runtime, JSON.stringify(['u1', 'p1']), true)), null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  assert.deepEqual(await out.store.act({ kind: 'google', intent: 'connect' }), { ok: true });
  assert.ok(requests.includes('momo.home.google'));
  await act(async () => root.unmount());
  host.remove();
});

test('the MoMo row follows the computer’s hello while the app is open, and only settings or home changes ask again', async () => {
  const { useMomoAccess } = await import(accessPath);
  let allowed = false;
  let reads = 0;
  const listeners: ((e: unknown) => void)[] = [];
  const runtime: any = {
    snapshot: () => ({ user: { id: 'u1' }, selectedPair: 'p1', phase: 'online' }),
    request: async () => (reads++, { capabilities: { momo: allowed } }),
    onEvent: (l: (e: unknown) => void) => (listeners.push(l), () => listeners.splice(listeners.indexOf(l), 1)),
  };
  const out: any = {};
  const Probe = () => ((out.on = useMomoAccess(runtime, true, true)), null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  await act(async () => undefined);
  assert.equal(out.on, false);
  const first = reads;
  allowed = true;
  // a channel change is not a hello change
  await act(async () => listeners.forEach((l) => l({ ev: 'momo.changed', area: 'channels' })));
  assert.equal(reads, first);
  await act(async () => listeners.forEach((l) => l({ ev: 'momo.changed', area: 'prefs' })));
  await act(async () => undefined);
  assert.equal(out.on, true);
  await act(async () => listeners.forEach((l) => l({ ev: 'momo.home.changed' })));
  assert.ok(reads > first + 1);
  await act(async () => root.unmount());
  assert.equal(listeners.length, 0);
  host.remove();
});

test('a computer that cannot tell of changes still gives its answer once', async () => {
  const { useMomoAccess } = await import(accessPath);
  const runtime: any = {
    snapshot: () => ({ user: { id: 'u1' }, selectedPair: 'p1', phase: 'online' }),
    request: async () => ({ capabilities: { momo: true } }),
  };
  const out: any = {};
  const Probe = () => ((out.on = useMomoAccess(runtime, true, true)), null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  await act(async () => undefined);
  assert.equal(out.on, true);
  await act(async () => root.unmount());
  host.remove();
});

test('MoMo is not asked where it is not wired or the computer is away', async () => {
  const { useMomoAccess } = await import(accessPath);
  let reads = 0;
  const runtime: any = {
    snapshot: () => ({ user: { id: 'u1' }, selectedPair: 'p1', phase: 'online' }),
    request: async () => (reads++, { capabilities: { momo: true } }),
    onEvent: () => () => undefined,
  };
  const out: any = {};
  const Probe = ({ wired, online }: { wired: boolean; online: boolean }) => ((out.on = useMomoAccess(runtime, wired, online)), null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  for (const [wired, online] of [
    [false, true],
    [true, false],
  ]) {
    await act(async () => root.render(createElement(Probe, { wired, online })));
    await act(async () => undefined);
    assert.equal(out.on, false);
  }
  assert.equal(reads, 0);
  await act(async () => root.unmount());
  host.remove();
});
