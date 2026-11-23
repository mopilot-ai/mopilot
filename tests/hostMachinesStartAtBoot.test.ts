// Keep running after restart through main (electron/host/machines.cjs, electron/app/ipc/host.cjs): the row carries what the Host said of starting at boot, FileVault and its system; both calls are refused while Host is not allowed and reach electron/host/startAtBoot.cjs otherwise; the IPC passes only a boolean and a string password, and the person's own refusals are not reported as errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');
const { register } = require('../electron/app/ipc/host.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');

const said = {
  harnesses: [{ id: 'claude', detected: true, signedIn: true }],
  capabilities: { shell: true },
  platform: 'darwin',
  startup: { atBoot: 'yes', fileVault: 'on' },
};

test('the row says what the Host said of starting at boot; the calls are gated and reach the start-at-boot service', async (t) => {
  const clock = installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-boot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let allowed = true;
  const call = async (_r: any, method: string) => (method === 'status' ? said : null);
  const registry = createRegistry({ file: path.join(dir, 'host-registry.json'), status: (r: any) => call(r, 'status') });
  const m = createMachines({
    dir,
    allowed: () => allowed,
    watch: () => undefined,
    call,
    registry,
    installer: { install: async () => ({}) },
  });
  t.after(() => m.dispose());
  registry.add({ id: 'ssh:linux', name: 'lin', address: 'me@lin', socketPath: '/h/host.sock', platform: 'linux' });
  await registry.check();
  clock.advance(0);
  const row = m.list().machines[0];
  assert.deepEqual([row.startsAtBoot, row.fileVault, row.platform], ['yes', 'on', 'darwin']);
  // the service's own refusals come through (here: no such machine; a machine it may not change)
  assert.throws(() => m.setStartAtBoot('nope', true, 'pw'), { code: 'unknown_machine' });
  await assert.rejects(m.startAtBootCommand('nope'), { code: 'unknown_machine' });
  allowed = false;
  assert.throws(() => m.setStartAtBoot('ssh:linux', true, 'pw'), { code: 'not_allowed' });
  assert.throws(() => m.startAtBootCommand('ssh:linux'), { code: 'not_allowed' });
});

test('IPC: setStartAtBoot passes a boolean and a string only; the command call passes the id; refusals the person can act on are not reported', async () => {
  const handlers = new Map<string, any>();
  const got: any[] = [];
  const svc: any = {
    list: () => ({ machines: [], resolved: true }),
    setStartAtBoot: async (...a: any[]) => void got.push(['set', ...a]),
    startAtBootCommand: async (id: string) => `cmd ${id}`,
  };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => '/ud' }, broadcastAll: () => undefined },
    { create: () => svc, allowed: () => true },
  );
  const call = (c: string, ...a: any[]) => handlers.get(c)({}, ...a);
  assert.deepEqual(await call('host:setStartAtBoot', 'ssh:m', true, 'pw'), { value: undefined });
  await call('host:setStartAtBoot', 'ssh:m', 'yes', 42);
  await call('host:setStartAtBoot');
  assert.deepEqual(got, [
    ['set', 'ssh:m', true, 'pw'],
    ['set', 'ssh:m', false, ''],
    ['set', '', false, ''],
  ]);
  assert.deepEqual(await call('host:startAtBootCommand', 'ssh:m'), { value: 'cmd ssh:m' });
  assert.deepEqual(await call('host:startAtBootCommand'), { value: 'cmd ' });
  for (const code of ['wrong_password', 'not_admin', 'busy']) {
    svc.setStartAtBoot = async () => {
      throw Object.assign(new Error('said'), { code });
    };
    assert.deepEqual(await call('host:setStartAtBoot', 'ssh:m', true, 'pw'), { error: { message: 'said', code } });
  }
});
