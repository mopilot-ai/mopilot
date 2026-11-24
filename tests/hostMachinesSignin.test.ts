// Sign-in in main's machines service (electron/host/machines.cjs) and IPC (electron/app/ipc/host.cjs): the list names the agent that can be signed in, a sign-in runs over a real remote Host through a tunnel and ends with a fresh status read, access lost or a machine removed ends it, and every call is refused while Host is not allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hostWorld, tick } from './support/host-wire-kit.ts';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');
const { register } = require('../electron/app/ipc/host.cjs');

const GEMINI = (signedIn: boolean) => ({ id: 'gemini', detected: true, signedIn });
const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await tick();
};

function world(t: any, o: { harnesses?: any[]; allowed?: boolean; bare?: boolean; openFails?: boolean } = {}) {
  const w = hostWorld(t);
  // a Host serves a paired client only: every connection proves the app's key first
  w.net.handlers['host.challenge'] = () => ({ nonce: 'n-1', hostId: 'abababababababababababababababab' });
  w.net.handlers['host.auth'] = () => ({ fingerprint: 'f' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-signin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gate = { allowed: o.allowed ?? true, fns: new Set<(ok: boolean) => void>() };
  const state = { harnesses: o.harnesses ?? [GEMINI(false)] };
  const status = () => ({ harnesses: state.harnesses, capabilities: { shell: true } });
  const registry = createRegistry({ file: path.join(dir, 'r.json'), status: async () => status() });
  registry.add({ id: 'ssh:box', name: 'box', address: 'me@box', socketPath: '/h/host.sock', harnesses: state.harnesses });
  const opened: string[] = [];
  const views: any[] = [];
  const ended: string[] = [];
  const tunnel = w.tunnel();
  const m = createMachines({
    safeStorage: keySafe,
    dir,
    allowed: () => gate.allowed,
    autoUpdateOn: () => false,
    watch: (fn: any) => gate.fns.add(fn),
    registry,
    installer: {},
    pool: { get: () => tunnel },
    call: async () => status(),
    connect: w.net.connect,
    onRemoteEnd: (id: string) => void ended.push(id),
    // a service made without a browser or a window still signs in (its links open nowhere, its views reach nobody)
    ...(o.bare
      ? {}
      : {
          openExternal: (u: string) => (o.openFails ? Promise.reject(new Error('no browser')) : void opened.push(u)),
          onSignin: (v: any) => views.push(v),
        }),
  });
  t.after(() => m.dispose());
  return {
    ...w,
    m,
    gate,
    state,
    status,
    registry,
    opened,
    views,
    ended,
    tunnel,
    set: (ok: boolean) => ((gate.allowed = ok), [...gate.fns].forEach((f) => f(ok))),
  };
}

/** The agent a row offers to sign in (the window reads it from `agents`; an offline machine offers none). */
const signinOf = (r: any) => (r.status === 'offline' ? null : (r.agents.find((a: any) => a.state === 'signin')?.id ?? null));

test('the list names the agent that is installed but signed out, only on a machine that answers', async (t) => {
  const w = world(t);
  await w.registry.check();
  assert.equal(signinOf(w.m.list().machines[0]), 'gemini');
  w.state.harnesses = [GEMINI(true)];
  await w.registry.check();
  assert.equal(signinOf(w.m.list().machines[0]), null, 'every agent is signed in');
  w.state.harnesses = [{ id: 'gemini', detected: false, signedIn: false }];
  await w.registry.check();
  assert.equal(signinOf(w.m.list().machines[0]), null, 'an agent that is not installed cannot be signed in');
  const fresh = world(t);
  assert.equal(fresh.m.list().machines[0].status, 'offline');
  assert.equal(signinOf(fresh.m.list().machines[0]), null, 'a machine that has not answered');
});

test('a sign-in runs over a remote Host through the tunnel: the link opens here, the code shows, a fresh status read confirms', async (t) => {
  const w = world(t);
  const asked: string[] = [];
  let polls = 0;
  w.net.handlers['host.challenge'] = () => (asked.push('challenge'), { nonce: 'n-1', hostId: 'abababababababababababababababab' });
  w.net.handlers['host.auth'] = (p) => (asked.push(`auth ${typeof p.signature}`), { fingerprint: 'f' });
  w.net.handlers['host.login'] = (p) => (asked.push(`login ${p.harness}`), { harness: p.harness, state: 'waiting', links: [], codes: [] });
  w.net.handlers['host.loginStatus'] = () =>
    ++polls < 2
      ? { state: 'waiting', links: ['https://login.test/x'], codes: ['ABCD-1234'] }
      : ((w.state.harnesses = [GEMINI(true)]), { state: 'done', links: ['https://login.test/x'], codes: ['ABCD-1234'] });
  w.net.handlers['host.status'] = () => (asked.push('status'), w.status());
  await w.registry.check();
  const first = w.m.signIn('ssh:box', 'gemini');
  assert.deepEqual([first.hostId, first.harness, first.state], ['ssh:box', 'gemini', 'starting']);
  await settle();
  assert.deepEqual(w.opened, ['https://login.test/x']);
  assert.equal(w.views.at(-1).state, 'waiting');
  assert.equal(w.m.signInViews()[0].state, 'waiting', 'a reopened window reads the existing main-owned attempt');
  assert.deepEqual(w.views.at(-1).codes, ['ABCD-1234']);
  w.clock.advance(1000);
  await settle();
  assert.equal(w.views.at(-1).state, 'signed-in');
  assert.deepEqual(asked, ['challenge', 'auth string', 'login gemini', 'status'], 'the app proves its key before anything else');
  assert.equal(signinOf(w.m.list().machines[0]), null, 'the registry read the machine again');
});

test('a machines service made without a browser or a window still runs a sign-in to its end', async (t) => {
  const w = world(t, { bare: true });
  w.net.handlers['host.login'] = () => ({ state: 'waiting' });
  w.net.handlers['host.loginStatus'] = () => (
    (w.state.harnesses = [GEMINI(true)]), { state: 'done', links: ['https://login.test/x'], codes: [] }
  );
  w.net.handlers['host.status'] = () => w.status();
  w.m.signIn('ssh:box', 'gemini');
  await settle();
  assert.deepEqual(w.opened, []);
  assert.equal(w.m.cancelSignIn('ssh:box', 'gemini'), false, 'it ended on its own');
});

test('a link that cannot be opened is reported and the sign-in goes on', async (t) => {
  const w = world(t, { openFails: true });
  w.net.handlers['host.login'] = () => ({ state: 'waiting' });
  w.net.handlers['host.loginStatus'] = () => ({ state: 'waiting', links: ['https://login.test/x'], codes: ['ABCD-1234'] });
  w.m.signIn('ssh:box', 'gemini');
  await settle();
  assert.equal(w.views.at(-1).state, 'waiting');
  assert.deepEqual(w.views.at(-1).codes, ['ABCD-1234']);
});

test('a typed code reaches the machine through the shared connection', async (t) => {
  const w = world(t);
  const typed: any[] = [];
  w.net.handlers['host.login'] = () => ({ state: 'waiting' });
  w.net.handlers['host.loginStatus'] = () => ({ state: 'waiting', links: ['https://login.test/x'], codes: [] });
  w.net.handlers['host.loginInput'] = (p) => (typed.push(p), { accepted: true });
  w.m.signIn('ssh:box', 'gemini');
  await settle();
  assert.equal(w.views.at(-1).link, true);
  assert.equal(await w.m.signInInput('ssh:box', 'gemini', 'abc'), true);
  assert.deepEqual(typed, [{ harness: 'gemini', text: 'abc' }]);
  w.set(false);
  assert.throws(
    () => w.m.signInInput('ssh:box', 'gemini', 'abc'),
    (e: any) => e.code === 'not_allowed',
  );
});

test('cancel stops the sign-in on the machine; a second sign-in joins the one under way', async (t) => {
  const w = world(t);
  const logins: string[] = [];
  const cancels: string[] = [];
  w.net.handlers['host.login'] = (p) => (logins.push(p.harness), { state: 'waiting' });
  w.net.handlers['host.loginStatus'] = () => ({ state: 'waiting', links: [], codes: [] });
  w.net.handlers['host.loginCancel'] = (p) => (cancels.push(p.harness), true);
  w.m.signIn('ssh:box', 'gemini');
  await settle();
  assert.equal(w.m.signIn('ssh:box', 'gemini').state, 'waiting');
  assert.equal(w.m.cancelSignIn('ssh:box', 'gemini'), true);
  await settle();
  assert.deepEqual([logins, cancels], [['gemini'], ['gemini']]);
  assert.equal(w.m.cancelSignIn('ssh:box', 'gemini'), false);
});

test('losing Host access ends a sign-in under way; removing the machine does too', async (t) => {
  const w = world(t);
  w.net.handlers['host.login'] = () => ({ state: 'waiting' });
  w.net.handlers['host.loginStatus'] = () => ({ state: 'waiting', links: [], codes: [] });
  w.m.signIn('ssh:box', 'gemini');
  await settle();
  w.set(false);
  assert.equal(w.views.at(-1).state, 'cancelled');
  w.set(true);
  w.m.signIn('ssh:box', 'gemini');
  await settle();
  assert.equal(w.views.at(-1).state, 'waiting');
  w.m.remove('ssh:box');
  assert.equal(w.views.at(-1).state, 'cancelled');
});

test('every sign-in call is refused while Host is not allowed, and an unknown machine or agent is refused with its code', async (t) => {
  const w = world(t, { allowed: false });
  for (const fn of [() => w.m.signIn('ssh:box', 'gemini'), () => w.m.cancelSignIn('ssh:box', 'gemini'), () => w.m.signInViews()])
    assert.throws(fn, (e: any) => e.code === 'not_allowed');
  w.set(true);
  assert.throws(
    () => w.m.signIn('ssh:nope', 'gemini'),
    (e: any) => e.code === 'unknown_machine',
  );
  assert.throws(
    () => w.m.signIn('ssh:box', 'codex'),
    (e: any) => e.code === 'invalid',
  );
  assert.equal(w.m.cancelSignIn('ssh:box', 'gemini'), false);
});

test('IPC: sign-in and cancel are handlers that return values or errors, and main wires the browser and the broadcast', async (t) => {
  let allowed = true;
  const handlers = new Map<string, any>();
  const ipcMain = { handle: (c: string, fn: any) => handlers.set(c, fn) };
  const svc: any = {
    signIn: (id: string, harness: string) => ({ id, harness, state: 'starting' }),
    signInViews: () => [{ hostId: 'ssh:a', harness: 'git:github.com', state: 'waiting' }],
    cancelSignIn: (id: string, harness: string) => id + harness,
    signInInput: (id: string, harness: string, text: string) => `${id}|${harness}|${text}`,
  };
  const broadcasts: any[] = [];
  const opened: string[] = [];
  let opts: any;
  register(
    ipcMain,
    {
      app: { getPath: () => '/ud' },
      shell: { openExternal: async (u: string) => void opened.push(u) },
      shellEnv: { childEnv: () => ({}) },
      broadcastAll: (...a: any[]) => broadcasts.push(a),
    },
    { create: (o: any) => ((opts = o), svc), allowed: () => allowed },
  );
  const call = (c: string, ...a: any[]) => handlers.get(c)({}, ...a);
  assert.deepEqual(await call('host:signin', 'ssh:a', 'gemini'), { value: { id: 'ssh:a', harness: 'gemini', state: 'starting' } });
  assert.deepEqual(await call('host:signin'), { value: { id: '', harness: '', state: 'starting' } });
  assert.deepEqual(await call('host:signinViews'), { value: svc.signInViews() });
  assert.deepEqual(await call('host:signinCancel', 'ssh:a', 'gemini'), { value: 'ssh:agemini' });
  assert.deepEqual(await call('host:signinCancel'), { value: '' });
  assert.deepEqual(await call('host:signinInput', 'ssh:a', 'gemini', 'abc'), { value: 'ssh:a|gemini|abc' });
  assert.deepEqual(await call('host:signinInput'), { value: '||' });
  await opts.openExternal('https://login.test/x');
  opts.onSignin({ state: 'waiting' });
  assert.deepEqual(opened, ['https://login.test/x']);
  assert.deepEqual(broadcasts, [['host:signin', { state: 'waiting' }]]);
  allowed = false;
  for (const c of ['host:signin', 'host:signinCancel', 'host:signinInput', 'host:signinViews'])
    assert.equal((await call(c, 'a', 'b')).error.code, 'not_allowed');
});

test('hostFor proves the app key on its connection, and a machine whose address changed gets a new one', async (t) => {
  const w = world(t);
  const seen: string[] = [];
  w.net.handlers['host.challenge'] = () => (seen.push('challenge'), { nonce: 'n-1', hostId: 'abababababababababababababababab' });
  w.net.handlers['host.auth'] = () => (seen.push('auth'), { fingerprint: 'f' });
  const first = w.m.hostFor('ssh:box');
  assert.equal(w.m.hostFor('ssh:box'), first, 'one connection per machine');
  await first.connect();
  assert.deepEqual(seen, ['challenge', 'auth']);
  w.registry.remove('ssh:box');
  w.registry.add({ id: 'ssh:box', name: 'box', address: 'me@moved', socketPath: '/h/host.sock', harnesses: w.state.harnesses });
  const second = w.m.hostFor('ssh:box');
  assert.notEqual(second, first);
  await assert.rejects(first.loginStatus({ harness: 'gemini' }), (e: any) => e.code === 'disposed', 'the old one went back to its tunnel');
});

test('removing a machine tells its Host to stop the sign-in before its connection ends; one added again under the same id keeps its connection', async (t) => {
  const w = world(t);
  const cancels: string[] = [];
  w.net.handlers['host.login'] = () => ({ state: 'waiting' });
  w.net.handlers['host.loginStatus'] = () => ({ state: 'waiting', links: [], codes: [] });
  w.net.handlers['host.loginCancel'] = (p) => (cancels.push(p.harness), true);
  w.m.signIn('ssh:box', 'gemini');
  await settle();
  const old = w.m.hostFor('ssh:box');
  w.m.remove('ssh:box');
  w.registry.add({ id: 'ssh:box', name: 'box', address: 'me@box', socketPath: '/h/host.sock', harnesses: w.state.harnesses });
  const again = w.m.hostFor('ssh:box');
  await settle();
  assert.deepEqual(cancels, ['gemini'], 'the Host was told');
  assert.deepEqual(w.ended, ['ssh:box'], 'what was built on the connection is told once it ended');
  assert.notEqual(again, old, 'the machine added again has a connection of its own');
  assert.equal(w.m.hostFor('ssh:box'), again);
  await assert.rejects(old.loginStatus({ harness: 'gemini' }), (e: any) => e.code === 'disposed');
});

test('removing a machine with no sign-in ends its connection at once', async (t) => {
  const w = world(t);
  const open = w.m.hostFor('ssh:box');
  w.m.remove('ssh:box');
  assert.deepEqual(w.ended, ['ssh:box']);
  await assert.rejects(open.loginStatus({ harness: 'gemini' }), (e: any) => e.code === 'disposed');
});
