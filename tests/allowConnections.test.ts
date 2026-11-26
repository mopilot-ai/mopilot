// "Allow connections" told to this Mac's own Host (electron/host/allowConnections.cjs, R2b of #5576): over the Host's CLI connection to a real served Host, when the switch changes (electron/remote/consent.cjs) and each time that Host comes to answer in the machine list (electron/app/ipc/host.cjs); a Host that does not pair by code is told nothing; every failure is reported, never thrown.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock } from './support/ports/clock.ts';
import { servedHost } from './support/hostClientsWorld.ts';
import { waitFor } from './support/waitFor.ts';

mock.module('electron', { exports: {} });
const require = createRequire(import.meta.url);
const { createAllowConnections, tellHost } = require('../electron/host/allowConnections.cjs');
const { createConsent } = require('../electron/remote/consent.cjs');
const { register } = require('../electron/app/ipc/host.cjs');
const frames = require('../shared/host/frames.mjs');
const LOCAL = 'this-mac-host';

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

/** A Host served on a real socket whose pairing by code only records what it is told (or none). */
async function hostTold(t: any, withService = true) {
  const told: boolean[] = [];
  const apps: (string | undefined)[] = [];
  const codePair = {
    connections: ({ open, app }: { open: boolean; app?: string }) => (told.push(open), apps.push(app), { open, cancelled: 0 }),
  };
  const w = await servedHost(t, withService ? { codePair } : {});
  return { socketPath: w.paths.socketPath as string, told, apps };
}

/** A socket the test drives: what was written, and the Host's side by hand. */
function fakeSocket() {
  const s: any = new EventEmitter();
  s.written = [] as any[];
  s.destroyed = false;
  s.write = (b: string) => void s.written.push(JSON.parse(b));
  s.destroy = () => void (s.destroyed = true);
  s.answer = (m: object) => s.emit('data', Buffer.from(frames.encodeControl(m)));
  return s;
}
const fakeTell = (s: any, o: Record<string, unknown> = {}) =>
  tellHost('/x.sock', true, '', { connect: () => s, readToken: () => 'tok', ...o });

test('the CLI tells a served Host whether connections are allowed, with the token beside its socket; a Host without pairing by code is told nothing', async (t) => {
  const h = await hostTold(t);
  assert.deepEqual(await tellHost(h.socketPath, false, 'a'.repeat(64)), { open: false, cancelled: 0 });
  assert.deepEqual(await tellHost(h.socketPath, true, ''), { open: true, cancelled: 0 });
  assert.deepEqual(h.told, [false, true]);
  assert.deepEqual(h.apps, ['a'.repeat(64), undefined], "this app's own key goes with the switch, and none is sent when it has none");
  const bare = await hostTold(t, false);
  assert.equal(await tellHost(bare.socketPath, true, ''), null);
  assert.deepEqual(bare.told, []);
  // no token, no CLI: nothing is sent as a stranger
  assert.throws(() => tellHost(path.join(os.tmpdir(), 'no-such-host.sock'), true, ''), { code: 'ENOENT' });
});

test("the Host's refusal, a socket that fails, closes, stays silent or sends what cannot be read are each a rejection, and the socket goes", async (t) => {
  const clock = useFakeClock(t, 0);
  let s = fakeSocket();
  let p = fakeTell(s);
  s.emit('connect');
  assert.equal(s.written[0].method, 'host.hello');
  assert.equal(s.written[0].token, 'tok');
  // an event and a binary frame are not answers
  s.answer({ event: 'codePair' });
  s.emit('data', Buffer.from(frames.encodeBinary({ id: 9 }, Buffer.from('x'))));
  s.answer({ id: 1, result: { agreed: { features: ['codePair'] } } });
  assert.deepEqual(s.written[1], { id: 2, method: 'host.codePair.connections', params: { open: true }, token: 'tok' });
  s.answer({ id: 2, error: 'This Mac could not keep the setting.', code: 'not_saved' });
  await assert.rejects(p, { code: 'not_saved', message: /could not keep/ });
  assert.equal(s.destroyed, true);
  s = fakeSocket();
  p = fakeTell(s);
  s.answer({ id: 1, error: 'Unknown method host.hello.' });
  await assert.rejects(p, (e: any) => !('code' in e) && /Unknown method/.test(e.message));
  // a hello with nothing agreed is a Host that does not pair by code
  s = fakeSocket();
  p = fakeTell(s);
  s.answer({ id: 1, result: {} });
  assert.equal(await p, null);
  s = fakeSocket();
  p = fakeTell(s);
  s.emit('error', new Error('ECONNREFUSED'));
  await assert.rejects(p, /ECONNREFUSED/);
  s = fakeSocket();
  p = fakeTell(s);
  s.emit('close');
  await assert.rejects(p, /closed the connection/);
  s = fakeSocket();
  p = fakeTell(s);
  s.emit('data', Buffer.from('{not json\n'));
  await assert.rejects(p, /cannot read/);
  s = fakeSocket();
  p = fakeTell(s, { timeoutMs: 100 });
  clock.advance(100);
  await assert.rejects(p, { code: 'host_unreachable' });
  assert.equal(s.destroyed, true);
});

test('the switch is told when this Mac’s Host comes to answer, and from then on at each change; a change during a telling is told after it, the last word wins', async (t) => {
  const told: [string, boolean, string][] = [];
  const reported: unknown[] = [];
  let on = false;
  const listeners: (() => void)[] = [];
  let unsubscribed = 0;
  const consent = {
    enabled: () => on,
    onChange: (fn: () => void) => (listeners.push(fn), () => void unsubscribed++),
  };
  let socket: string | null = '/h.sock';
  let gate: (() => void) | null = null;
  const a = createAllowConnections({
    machines: () =>
      socket === null ? null : { row: (id: string) => (id === LOCAL ? { socketPath: socket } : undefined), selfFingerprint: () => 'me' },
    consent: () => consent,
    report: (e: unknown) => void reported.push(e),
    tell: async (at: string, open: boolean, app: string) => {
      told.push([at, open, app]);
      if (gate === null && told.length === 2) await new Promise<void>((r) => (gate = r));
      if (open && told.length === 5) throw new Error('host away');
      return { open, cancelled: 0 };
    },
  });
  a.rows({ machines: [{ id: 'other', status: 'online' }] });
  a.rows({ machines: [{ id: LOCAL, status: 'offline' }] });
  await flush();
  assert.deepEqual([told, listeners.length], [[], 0], 'nothing before the Host answers');
  a.rows({ machines: [{ id: LOCAL, status: 'attention' }] });
  await flush();
  assert.deepEqual(told, [['/h.sock', false, 'me']], 'a Host that answers but needs a sign-in is told too, with this app’s key');
  a.rows({ machines: [{ id: LOCAL, status: 'online' }] });
  await flush();
  assert.equal(told.length, 1, 'still up: not told again');
  assert.equal(listeners.length, 1);
  on = true;
  listeners[0]();
  await flush();
  // the second telling is held; two changes meanwhile are told once, as the switch is then
  on = false;
  listeners[0]();
  on = true;
  listeners[0]();
  (gate as unknown as () => void)();
  await flush();
  assert.deepEqual(told.slice(1), [
    ['/h.sock', true, 'me'],
    ['/h.sock', true, 'me'],
  ]);
  // the Host went away and came back: told again, and subscribed only once
  a.rows({ machines: [] });
  a.rows({ machines: [{ id: LOCAL, status: 'online' }] });
  await flush();
  assert.deepEqual(told.at(-1), ['/h.sock', true, 'me']);
  assert.equal(listeners.length, 1);
  listeners[0]();
  await flush();
  assert.match(String(reported[0]), /host away/, 'a failed telling is reported, not thrown');
  socket = '';
  listeners[0]();
  await flush();
  socket = null;
  listeners[0]();
  await flush();
  assert.equal(told.length, 5, 'no Host socket in the list, or no list: nothing to tell');
  a.dispose();
  a.dispose();
  assert.equal(unsubscribed, 1);
});

test('before a pairing the Host is told at once, with this app’s key (none before the list is made); a telling that fails is reported, not thrown', async () => {
  const told: [string, boolean, string][] = [];
  const reported: unknown[] = [];
  let list: any = null;
  const a = createAllowConnections({
    machines: () => list,
    consent: () => ({ enabled: () => true, onChange: () => () => undefined }),
    report: (e: unknown) => void reported.push(e),
    tell: async (at: string, open: boolean, app: string) => {
      if (at === '/broken.sock') throw new Error('no token');
      told.push([at, open, app]);
    },
  });
  await a.beforePair('/h.sock');
  list = { row: () => undefined, selfFingerprint: () => 'me' };
  await a.beforePair('/h.sock');
  await a.beforePair('/broken.sock');
  assert.deepEqual(told, [
    ['/h.sock', true, ''],
    ['/h.sock', true, 'me'],
  ]);
  assert.match(String(reported[0]), /no token/);
});

test('a change that comes as a telling ends its turn is told once more; no switch is off', async (t) => {
  const told: boolean[] = [];
  let a: any;
  let first = true;
  a = createAllowConnections({
    machines: () => ({ row: () => ({ socketPath: '/h.sock' }), selfFingerprint: () => 'me' }),
    consent: () => undefined,
    report: () => undefined,
    tell: async (_at: string, open: boolean) => {
      told.push(open);
      if (first) {
        first = false;
        // after the loop looked at `again` and before its turn ended
        Promise.resolve().then(() => Promise.resolve().then(() => void a.push()));
      }
    },
  });
  a.rows({ machines: [{ id: LOCAL, status: 'online' }] });
  await flush();
  assert.deepEqual(told, [false, false]);
  a.dispose();
});

test('the consent tells who follows it after every change asked of it, kept or not; a listener that throws is noted, one that stopped is not told', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-conn-consent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const live: any = { mopilot: { creds: { user: { id: 'u' }, deviceId: 'd' } } };
  let prefs: any = {};
  let fail = false;
  const consent = createConsent(
    live,
    () => ({ prefs }),
    (_file: string, patch: any) => (fail ? false : ((prefs = { ...prefs, ...patch }), true)),
    () => path.join(dir, 'state.json'),
  );
  const heard: boolean[] = [];
  const stop = consent.onChange(() => heard.push(consent.enabled()));
  consent.onChange(() => {
    throw new Error('listener broke');
  });
  consent.set(true);
  fail = true;
  assert.throws(() => consent.set(false));
  fail = false;
  consent.set(false);
  stop();
  consent.set(true);
  assert.deepEqual(heard, [true, false, false]);
});

test('the app wiring: this Mac’s Host in the list is told the switch over its socket, then each change of it; quitting stops listening', async (t) => {
  const h = await hostTold(t);
  let on = true;
  const listeners = new Set<() => void>();
  const remoteConsent = {
    enabled: () => on,
    onChange: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
  };
  const live: any = { remoteConsent };
  let opts: any;
  let quit: (() => void) | undefined;
  const handlers = new Map<string, any>();
  const svc: any = {
    list: () => ({ machines: [], resolved: true }),
    row: (id: string) => (id === LOCAL ? { socketPath: h.socketPath } : undefined),
    selfFingerprint: () => 'b'.repeat(64),
    dispose: () => undefined,
  };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    {
      app: { getPath: () => os.tmpdir(), once: (e: string, fn: () => void) => void (e === 'will-quit' && (quit = fn)) },
      shellEnv: { childEnv: () => ({}) },
      broadcastAll: () => undefined,
      live,
    },
    { create: (o: any) => ((opts = o), svc), allowed: () => true },
  );
  // the accessor this Mac's own Host's socket is read through: none before the machine list is made
  assert.equal(live.localHostSocket(), '');
  await handlers.get('host:machines')({});
  assert.equal(live.localHostSocket(), h.socketPath);
  opts.onChange({ machines: [{ id: LOCAL, status: 'online' }], resolved: true });
  await waitFor(() => h.told.length >= 1, 'the Host told the switch on connect');
  assert.deepEqual([h.told, h.apps], [[true], ['b'.repeat(64)]], 'told with this app’s own key');
  // before this app pairs with its own Host, that Host is told first (machines.cjs `pair`)
  await opts.beforeLocalPair(h.socketPath);
  assert.deepEqual([h.told, h.apps.at(-1)], [[true, true], 'b'.repeat(64)]);
  h.told.pop();
  on = false;
  for (const fn of listeners) fn();
  await waitFor(() => h.told.length >= 2, 'the Host told the change');
  assert.deepEqual(h.told, [true, false]);
  assert.equal(listeners.size, 1);
  // a Host whose token cannot be read is not told, and that is noted, not thrown
  svc.row = () => ({ socketPath: path.join(os.tmpdir(), 'no-such-host-here.sock') });
  for (const fn of listeners) fn();
  await flush();
  assert.deepEqual(h.told, [true, false]);
  try {
    quit?.();
  } catch {
    // the rest of the quit's teardown is not this test's
  }
  assert.equal(listeners.size, 0);
  svc.row = () => ({});
  assert.equal(live.localHostSocket(), '', 'a row with no socket');
  svc.row = () => undefined;
  assert.equal(live.localHostSocket(), '', 'no row');
});

test('a key rotation tells this Mac’s Host the new key, whether it finished or not, so "off" still lets this app in', async (t) => {
  const h = await hostTold(t);
  let opts: any;
  let me = 'b'.repeat(64);
  let fails = false;
  const handlers = new Map<string, any>();
  const svc: any = {
    list: () => ({ machines: [], resolved: true }),
    row: (id: string) => (id === LOCAL ? { socketPath: h.socketPath } : undefined),
    selfFingerprint: () => me,
    rotateKey: async () => {
      me = 'c'.repeat(64);
      if (fails) throw new Error('a machine did not take the new key');
      return { machines: 1, pending: [] };
    },
  };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    {
      app: { getPath: () => os.tmpdir() },
      shellEnv: { childEnv: () => ({}) },
      broadcastAll: () => undefined,
      live: { remoteConsent: { enabled: () => false, onChange: () => () => undefined } },
    },
    { create: (o: any) => ((opts = o), svc), allowed: () => true },
  );
  await handlers.get('host:machines')({});
  opts.onChange({ machines: [{ id: LOCAL, status: 'online' }], resolved: true });
  await waitFor(() => h.apps.length >= 1, 'the Host told on connect');
  assert.deepEqual((await handlers.get('host:rotateKey')()).value, { machines: 1, pending: [] });
  await waitFor(() => h.apps.at(-1) === 'c'.repeat(64), 'the Host told the new key');
  fails = true;
  me = 'd'.repeat(64);
  assert.match(String((await handlers.get('host:rotateKey')()).error?.message), /did not take/, 'the failure is still the answer');
  await waitFor(() => h.apps.at(-1) === 'c'.repeat(64) && h.apps.length >= 3, 'told again after a rotation that failed');
});

test('the app wiring without a consent or a Host row tells a Host nothing and reports nothing', async () => {
  let opts: any;
  const handlers = new Map<string, any>();
  const svc: any = { list: () => ({ machines: [], resolved: true }), row: () => undefined, selfFingerprint: () => '' };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => os.tmpdir() }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { create: (o: any) => ((opts = o), svc), allowed: () => true },
  );
  await handlers.get('host:machines')({});
  opts.onChange({ machines: [{ id: LOCAL, status: 'online' }], resolved: true });
  await flush();
});
