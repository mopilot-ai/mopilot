// Installing an agent in main's machines service (electron/host/machines.cjs) and IPC (electron/app/ipc/host.cjs): the list names the agents a machine's Host can install, an install runs over a real remote Host through a tunnel and ends with the machine read again (the agent then needs sign-in), access lost or a machine removed ends it, and every call is refused while Host is not allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hostWorld, tick } from './support/host-wire-kit.ts';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const S = require('../shared/host/schema.mjs');
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');
const { register } = require('../electron/app/ipc/host.cjs');

const MISSING = { id: 'codex', detected: false, signedIn: false, installable: true };
const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await tick();
};

function world(t: any, o: { allowed?: boolean; bare?: boolean } = {}) {
  const w = hostWorld(t);
  w.net.handlers['host.challenge'] = () => ({ nonce: 'n-1', hostId: 'abababababababababababababababab' });
  w.net.handlers['host.auth'] = () => ({ fingerprint: 'f' });
  // a Host of this build: it speaks `install`
  w.net.handlers['host.hello'] = () => S.helloParams();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gate = { allowed: o.allowed ?? true, fns: new Set<(ok: boolean) => void>() };
  const state = { harnesses: [MISSING, { id: 'claude', detected: true, signedIn: true }] as any[] };
  const status = () => ({ harnesses: state.harnesses, capabilities: {} });
  const registry = createRegistry({ file: path.join(dir, 'r.json'), status: async () => status() });
  registry.add({ id: 'ssh:box', name: 'box', address: 'me@box', socketPath: '/h/host.sock', harnesses: state.harnesses });
  const views: any[] = [];
  const tunnel = w.tunnel();
  const m = createMachines({
    safeStorage: keySafe,
    dir,
    allowed: () => gate.allowed,
    watch: (fn: any) => gate.fns.add(fn),
    registry,
    installer: {},
    pool: { get: () => tunnel },
    call: async () => status(),
    connect: w.net.connect,
    ...(o.bare ? {} : { onInstall: (v: any) => views.push(v) }),
  });
  t.after(() => m.dispose());
  return { ...w, m, gate, state, registry, views, set: (ok: boolean) => ((gate.allowed = ok), [...gate.fns].forEach((f) => f(ok))) };
}

test('the list names the missing agents the machine can install, only while it answers', async (t) => {
  const w = world(t);
  assert.deepEqual(w.m.list().machines[0].installable, [], 'a machine that has not answered');
  await w.registry.check();
  assert.deepEqual(w.m.list().machines[0].installable, ['codex']);
  // an older Host says nothing of `installable`; an installed agent is not offered
  w.state.harnesses = [
    { id: 'codex', detected: false, signedIn: false },
    { id: 'gemini', detected: true, signedIn: false, installable: true },
  ];
  await w.registry.check();
  assert.deepEqual(w.m.list().machines[0].installable, []);
});

test('an install runs over a remote Host through the tunnel and the agent then shows as needing sign-in', async (t) => {
  const w = world(t);
  const asked: string[] = [];
  let polls = 0;
  w.net.handlers['host.install'] = (p) => (
    asked.push(`install ${p.harness}`), { harness: p.harness, state: 'running', line: 'Installing Codex…' }
  );
  w.net.handlers['host.installStatus'] = () =>
    ++polls < 2
      ? { state: 'running', line: 'added 2 packages' }
      : ((w.state.harnesses = [{ id: 'codex', detected: true, signedIn: false }]), { state: 'done', version: 'codex-cli 1.0.0' });
  await w.registry.check();
  const first = w.m.installAgent('ssh:box', 'codex');
  assert.deepEqual([first.state, w.m.installAgent('ssh:box', 'codex').state], ['queued', 'queued'], 'a second click joins it');
  await settle();
  assert.equal(w.views.at(-1).line, 'Installing Codex…');
  w.clock.advance(1000);
  await settle();
  assert.equal(w.views.at(-1).line, 'added 2 packages');
  w.clock.advance(1000);
  await settle();
  assert.deepEqual([w.views.at(-1).state, w.views.at(-1).version], ['installed', 'codex-cli 1.0.0']);
  assert.deepEqual(asked, ['install codex']);
  const row = w.m.list().machines[0];
  assert.deepEqual([row.installable, row.agents.find((a: any) => a.id === 'codex').state], [[], 'signin']);
});

test('cancel stops the install on the machine; losing access or removing the machine ends it; a bare service still runs one', async (t) => {
  const w = world(t);
  const cancels: string[] = [];
  w.net.handlers['host.install'] = () => ({ state: 'running', line: '' });
  w.net.handlers['host.installStatus'] = () => ({ state: 'running', line: '' });
  w.net.handlers['host.installCancel'] = (p) => (cancels.push(p.harness), true);
  await w.registry.check();
  w.m.installAgent('ssh:box', 'codex');
  await settle();
  assert.equal(w.m.cancelInstall('ssh:box', 'codex'), true);
  await settle();
  assert.deepEqual(cancels, ['codex']);
  assert.equal(w.m.cancelInstall('ssh:box', 'codex'), false);
  w.m.installAgent('ssh:box', 'codex');
  await settle();
  w.set(false);
  await settle();
  assert.equal(w.views.at(-1).state, 'cancelled');
  w.set(true);
  await w.registry.check();
  w.m.installAgent('ssh:box', 'codex');
  await settle();
  w.m.remove('ssh:box');
  await settle();
  assert.equal(w.views.at(-1).state, 'cancelled');
  assert.deepEqual(cancels, ['codex', 'codex'], 'the machine was told before its connection ended');
  const bare = world(t, { bare: true });
  bare.net.handlers['host.install'] = () => ({ state: 'done' });
  await bare.registry.check();
  bare.m.installAgent('ssh:box', 'codex');
  await settle();
  assert.equal(bare.m.cancelInstall('ssh:box', 'codex'), false, 'it ended on its own');
});

test('a cancel the machine refuses is reported, not thrown', async (t) => {
  const w = world(t);
  w.net.handlers['host.install'] = () => ({ state: 'running', line: '' });
  w.net.handlers['host.installStatus'] = () => ({ state: 'running', line: '' });
  w.net.raw['host.installCancel'] = (id: any) => ({ id, error: 'no such install' });
  await w.registry.check();
  w.m.installAgent('ssh:box', 'codex');
  await settle();
  assert.equal(w.m.cancelInstall('ssh:box', 'codex'), true);
  await settle();
  assert.equal(w.views.at(-1).state, 'cancelled');
});

test('every install call is refused while Host is not allowed', async (t) => {
  const w = world(t, { allowed: false });
  for (const fn of [() => w.m.installAgent('ssh:box', 'codex'), () => w.m.cancelInstall('ssh:box', 'codex')])
    assert.throws(fn, (e: any) => e.code === 'not_allowed');
});

test('IPC: install and cancel are handlers that return values or errors, and main broadcasts each change', async () => {
  let allowed = true;
  const handlers = new Map<string, any>();
  const svc: any = {
    installAgent: (id: string, harness: string) => ({ id, harness, state: 'queued' }),
    cancelInstall: (id: string, harness: string) => id + harness,
  };
  const broadcasts: any[] = [];
  let opts: any;
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    {
      app: { getPath: () => '/ud' },
      shell: { openExternal: async () => undefined },
      shellEnv: { childEnv: () => ({}) },
      broadcastAll: (...a: any[]) => broadcasts.push(a),
    },
    { create: (o: any) => ((opts = o), svc), allowed: () => allowed },
  );
  const call = (c: string, ...a: any[]) => handlers.get(c)({}, ...a);
  assert.deepEqual(await call('host:agentInstall', 'ssh:a', 'codex'), { value: { id: 'ssh:a', harness: 'codex', state: 'queued' } });
  assert.deepEqual(await call('host:agentInstall'), { value: { id: '', harness: '', state: 'queued' } });
  assert.deepEqual(await call('host:agentInstallCancel', 'ssh:a', 'codex'), { value: 'ssh:acodex' });
  assert.deepEqual(await call('host:agentInstallCancel'), { value: '' });
  opts.onInstall({ state: 'running' });
  assert.deepEqual(broadcasts, [['host:agentInstall', { state: 'running' }]]);
  allowed = false;
  for (const c of ['host:agentInstall', 'host:agentInstallCancel']) assert.equal((await call(c, 'a', 'b')).error.code, 'not_allowed');
});
