// The machines service with a relay path (electron/host/machines.cjs, #2709): tunnels come from the relay's joined pool, a row says
// how its machine is reached, a machine that cannot be reached says the path's own reason when it has a relay path (SSH's otherwise),
// a path can be pinned, and removing a machine takes its relay path with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { CORE_BUILDS } from '../shared/host/coreBuild.mjs';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');

const ready = { harnesses: [{ id: 'claude', detected: true, signedIn: true }], capabilities: { shell: true } };

test('a machine on the relay: its row, a refusal in its path’s words, a pinned path, and Remove taking the path away', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrelay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const call = async (_r: any, method: string) => (method === 'status' ? ready : null);
  const registry = createRegistry({ file: path.join(dir, 'host-registry.json'), status: (r: any) => call(r, 'status') });
  const tunnel = {
    path: 'relay',
    latencyMs: 21,
    reason: 'The machine is not connected to the relay.',
    acquire: () => ({ socketPath: '/x', ready: Promise.resolve(false), release: () => undefined }),
  };
  const enrolled = new Set(['far']);
  const seen: any = { modes: [], forgot: [], pooled: 0, disposed: false };
  const laneFns = new Set<() => void>();
  const relay = {
    pool: (ssh: any) => ((seen.ssh = ssh), { get: () => (seen.pooled++, tunnel), closeAll: () => undefined }),
    enrolled: (a: string) => enrolled.has(a),
    removedByPeer: () => false,
    view: (a: string, tun: any) => ({ mode: 'auto', relay: enrolled.has(a), path: tun?.path ?? null, latencyMs: tun?.latencyMs ?? null }),
    lane: { onChange: (fn: () => void) => (laneFns.add(fn), () => laneFns.delete(fn)) },
    setMode: (a: string, m: string) => seen.modes.push([a, m]),
    forget: async (a: string) => (seen.forgot.push(a), true),
    enroll: async () => null,
    dispose: () => (seen.disposed = true),
  };
  const changes: any[] = [];
  const m = createMachines({
    safeStorage: keySafe,
    dir,
    allowed: () => true,
    watch: () => undefined,
    call,
    registry,
    installer: { install: async () => ({ ok: false }) },
    pool: { get: () => tunnel, closeAll: () => undefined },
    relay,
    onChange: (s: any) => changes.push(s),
  });
  t.after(() => m.dispose());
  registry.add({ id: 'ssh:far', name: 'far', address: 'far', socketPath: '/h/host.sock' });
  registry.add({ id: 'ssh:near', name: 'near', address: 'near', socketPath: '/h/host.sock' });
  const rows = m.list().machines;
  assert.equal(rows.find((r: any) => r.id === 'ssh:far').path.path, 'relay');
  assert.ok(seen.ssh, 'the relay joins the SSH pool');
  // the path's own reason for a machine with a relay path; SSH's words for one without
  await assert.rejects(m.session('ssh:far'), /not connected to the relay/);
  await assert.rejects(m.session('ssh:near'), /over SSH/);
  tunnel.reason = '';
  await assert.rejects(m.session('ssh:far'), (e: any) => e.message === 'Could not reach the machine.');
  const before = changes.length;
  m.setPath('ssh:far', 'ssh');
  assert.deepEqual(seen.modes, [['far', 'ssh']]);
  assert.ok(changes.length > before, 'the windows get the list again');
  for (const fn of laneFns) fn();
  m.remove('ssh:far');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen.forgot, ['far']);
});

test('Add by command through the machines service: a command made with the app’s own Host bundle and update key', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mboot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = createRegistry({ file: path.join(dir, 'host-registry.json'), status: async () => ready });
  const lane: any = {
    whenOpen: async () => undefined,
    intend: () => undefined,
    register: async () => undefined,
    request: async () => undefined,
    revoke: async () => undefined,
    route: () => () => undefined,
    onBoot: () => () => undefined,
    onChange: () => () => undefined,
  };
  const relay: any = {
    lane,
    url: () => 'wss://relay.example/v1/ws',
    pool: (ssh: any) => ssh,
    enrolled: () => false,
    needsRotation: () => false,
    removedByPeer: () => false,
    dispose: () => undefined,
  };
  // the command names every machine's build, which a release carries and a checkout has only for itself
  const root = path.join(dir, 'app');
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put('host/package.json', JSON.stringify({ version: '0.0.9' }));
  put('host/bin/mopilot-host.mjs', 'export {};');
  for (const build of CORE_BUILDS) put(`build/vendor/host-core/${build}/mopilot_core.node`, build);
  const m = createMachines({
    safeStorage: keySafe,
    dir,
    root,
    allowed: () => true,
    watch: () => undefined,
    call: async () => ready,
    registry,
    installer: { install: async () => ({ ok: false }) },
    pool: { get: () => null, closeAll: () => undefined },
    relay,
  });
  t.after(() => m.dispose());
  const view = await m.boot.start();
  assert.equal(view.state, 'waiting');
  assert.match(view.command, /^f=\$\(mktemp\) && curl -fsSL 'https:\/\/relay\.example\/v1\/boot\/b_/);
});
