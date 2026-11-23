// Main's machines service for Remove and Update on a listed machine (machines.removePlan, uninstallHost, updateHost): the same checks as the sheets ask, the Host's version in the row, and an update's state kept for the row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { keySafe } from './support/hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');
const { appHostBuild } = require('../electron/host/bundle.cjs');

function world(
  t: any,
  o: {
    build?: string;
    allowed?: boolean;
    appVersion?: string;
    hostVersion?: string;
    address?: string;
    liveVersion?: () => string | undefined;
  } = {},
) {
  installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-ru-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-root-'));
  fs.mkdirSync(path.join(root, 'host/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: o.appVersion ?? '0.4.27' }));
  fs.writeFileSync(path.join(root, 'host/bin/mopilot-host.mjs'), 'export {};\n');
  const appBuild = appHostBuild(root);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ran: string[] = [];
  const call = async (_r: any, method: string) => {
    if (method === 'idle') return { idle: false };
    return {
      build: o.build ?? 'an-older-build',
      appVersion: o.liveVersion ? o.liveVersion() : o.hostVersion,
      harnesses: [{ id: 'claude', detected: true, signedIn: true }],
      capabilities: {},
    };
  };
  const registry = createRegistry({ file: path.join(dir, 'r.json'), status: (r: any) => call(r, 'status') });
  registry.add({ id: o.address ? `${o.address}` : 'ssh:me@box', name: 'box', address: o.address ?? 'me@box', socketPath: '/h/host.sock' });
  const m = createMachines({
    safeStorage: keySafe,
    dir,
    root,
    allowed: () => o.allowed ?? true,
    watch: () => undefined,
    call,
    registry,
    channel: async (_d: string, command: string) => (ran.push(command), { code: 0, stdout: '', stderr: '' }),
    installer: { install: async () => ({ ok: true }) },
  });
  t.after(() => m.dispose());
  return { m, registry, ran, appBuild };
}

test('the row says the Host is older than the app’s once it has answered, and a current one says nothing', async (t) => {
  const old = world(t);
  await old.registry.check();
  assert.equal(old.m.list().machines[0].hostStale, true);
  const current = world(t);
  assert.equal(current.appBuild.length, 16);
  const same = world(t, { build: current.appBuild });
  await same.registry.check();
  assert.equal('hostStale' in same.m.list().machines[0], false);
  // an app whose Host files cannot be listed has no build to compare
  assert.equal(appHostBuild(fs.mkdtempSync(path.join(os.tmpdir(), 'no-host-'))), '');
});

test('removePlan and uninstallHost reach the machine through its ssh and are refused without Host access', async (t) => {
  const w = world(t);
  await w.registry.check();
  assert.deepEqual(await w.m.removePlan('ssh:me@box'), {
    ssh: true,
    reachable: true,
    online: true,
    busy: 'yes',
    daemon: false,
    unsure: false,
    shared: '',
    why: '',
  });
  assert.deepEqual(await w.m.uninstallHost('ssh:me@box', ''), { left: '' });
  assert.equal(w.ran.length, 3, 'the ssh question, the uninstall and the deletion');
  const closed = world(t, { allowed: false });
  assert.throws(() => closed.m.removePlan('ssh:me@box'));
  assert.throws(() => closed.m.uninstallHost('ssh:me@box', ''));
});

test('rotateKey is refused without Host access, and stops before anything is sent when a machine is out of date', async (t) => {
  const w = world(t);
  await w.registry.check();
  await assert.rejects(w.m.rotateKey(), (e: any) => e.code === 'rotation_blocked' && /box/.test(e.message));
  assert.deepEqual(w.ran, []);
  const closed = world(t, { allowed: false });
  assert.throws(() => closed.m.rotateKey());
});

test('a failed update is kept for the row with its cause, and Remove forgets it', async (t) => {
  const w = world(t);
  await w.registry.check();
  await assert.rejects(w.m.updateHost('ssh:me@box'), (e: any) => e.code === 'not_paired');
  const [row] = w.m.list().machines;
  assert.equal(row.update, 'failed');
  assert.match(row.updateError, /Pair this machine/);
  w.m.remove('ssh:me@box');
  assert.equal(w.m.list().machines.length, 0);
});

test('#4923: a Host newer than the app is listed as newer, Update is refused before anything is sent, and the rotation names it', async (t) => {
  const w = world(t, { hostVersion: '0.5.0' });
  await w.registry.check();
  const [row] = w.m.list().machines;
  assert.equal(row.hostNewer, true);
  assert.equal('hostStale' in row, false);
  await assert.rejects(w.m.updateHost('ssh:me@box'), (e: any) => e.code === 'host_newer' && /newer than this app/.test(e.message));
  assert.deepEqual(w.ran, [], 'nothing was sent to the machine');
  await assert.rejects(w.m.rotateKey(), (e: any) => e.code === 'rotation_blocked' && /Update MoPilot first: box/.test(e.message));
  assert.deepEqual(w.ran, []);
  // an older one is still updated, and one of this version with another build says it differs
  const older = world(t, { hostVersion: '0.4.0' });
  await older.registry.check();
  assert.equal(older.m.list().machines[0].hostStale, true);
  const same = world(t, { hostVersion: '0.4.27' });
  await same.registry.check();
  assert.deepEqual([same.m.list().machines[0].hostStale, same.m.list().machines[0].hostDiffers], [true, true]);
});

test('#4912: a machine added by command is told, not offered an Update the app cannot send, and the rotation names it with the way out', async (t) => {
  const w = world(t, { address: 'relay:abc' });
  await w.registry.check();
  await assert.rejects(
    w.m.rotateKey(),
    (e: any) => e.code === 'rotation_blocked' && /No ssh to give a new key: box\. Remove it, rotate, then add it again\./.test(e.message),
  );
  assert.deepEqual(w.ran, []);
});

test('#4923: the registry said older but the Host is newer by now (another Mac updated it): Update and a rotation stop on what the Host says', async (t) => {
  let live: string | undefined = '0.4.0';
  const w = world(t, { hostVersion: '0.4.0', liveVersion: () => live });
  await w.registry.check();
  assert.equal(w.m.list().machines[0].hostStale, true, 'the record is older');
  live = '0.5.0';
  await assert.rejects(w.m.updateHost('ssh:me@box'), (e: any) => e.code === 'host_newer');
  assert.equal(w.ran.length, 0, 'nothing was sent to the machine');
});
