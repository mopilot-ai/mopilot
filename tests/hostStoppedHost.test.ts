// A machine whose ssh answers but whose Host does not (Remote Run audit, rr-accept-kit J12b case A): the probe says the Host is not running, the registry keeps that as the reason, and the row says so instead of the ssh failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { createMachines } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { createSigninWait } = require('../electron/host/signinWait.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');
const { createHostStarter, START } = require('../electron/host/startHost.cjs');
const { offlineCause } = require('../shared/host/machineLine.mjs');

const rec = (o: object = {}) => ({
  id: 'h1',
  address: 'me@build',
  identity: '',
  lastHeartbeat: 1_000_000,
  startup: { atBoot: 'no', fileVault: 'off' },
  ...o,
});
const probe = (reply: { code: number; stdout?: string; stderr?: string }) =>
  createSigninWait({ run: async () => ({ stdout: '', stderr: '', ...reply }) });

test('ssh answering with nobody waiting to sign in says the Host is not running; ssh failing says nothing; a waiting machine says it waits', async (t) => {
  installFakeClock(t, 5_000_000);
  assert.equal(await probe({ code: 0, stdout: 'me\nme\n{ sec = 6000, usec = 0 }\n' })(rec()), 'host-stopped', 'signed in on a Mac');
  assert.equal(
    await probe({ code: 0, stdout: 'root\nme\n{ sec = 6000, usec = 0 }\n' })(rec({ startup: { atBoot: 'yes', fileVault: 'off' } })),
    'host-stopped',
    'a boot daemon waits for nobody',
  );
  assert.equal(await probe({ code: 1 })(rec()), 'host-stopped', 'another system: the command found nothing, ssh worked');
  assert.equal(await probe({ code: 255 })(rec()), null, 'ssh itself failed');
  assert.equal(await probe({ code: -1 })(rec()), null, 'ssh did not start, or timed out');
  assert.equal(
    await probe({ code: 0, stdout: 'root\nme\n{ sec = 6000, usec = 0 }\n' })(rec()),
    'restarted',
    'a wait for the sign-in stays what it was',
  );
  assert.equal(
    await probe({ code: 255, stderr: 'Permission denied (publickey,password,keyboard-interactive).' })(
      rec({ startup: { atBoot: 'no', fileVault: 'on' } }),
    ),
    'locked',
  );
});

test('the registry keeps "its Host does not answer" as the reason and flags the row, and an answer clears it', async (t) => {
  const clock = installFakeClock(t, 1_000_000);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stopped-host-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  let up = true;
  const registry = createRegistry({
    file: path.join(d, 'hosts.json'),
    status: async () => {
      if (!up) throw new Error('The machine closed the connection.');
      return { harnesses: [], capabilities: {} };
    },
    explain: async () => 'host-stopped',
    report: () => undefined,
  });
  t.after(() => registry.dispose());
  registry.add({ id: 'h1', name: 'box', address: 'me@box' });
  await registry.check();
  assert.equal(registry.list()[0].hostStopped, false);
  up = false;
  clock.advance(100_000);
  await registry.check();
  await new Promise((r) => setImmediate(r));
  const [row] = registry.list();
  assert.equal(row.status, 'offline');
  assert.equal(row.reason, 'The machine answers over ssh, but its Host does not.');
  assert.equal(row.hostStopped, true);
  assert.equal(row.waitingForLogin, null, 'not a wait for a sign-in');
  up = true;
  await registry.check();
  assert.equal(registry.list()[0].hostStopped, false, 'an answer clears it');
});

test('the cause a stopped Host gets in words: ssh works, start the Host; other causes keep theirs', () => {
  assert.deepEqual(offlineCause('The machine answers over ssh, but its Host does not.', 'darwin'), {
    cause: 'Its Host isn’t running',
    hint: 'ssh works: start the Host on it.',
  });
  assert.equal(offlineCause('Unreachable: Connection refused', 'darwin').cause, 'Remote Login is off');
});

test('Start Host runs the start command over ssh and asks the machines again; each refusal says what to do', async () => {
  const row = (o: object = {}) => ({ id: 'h1', name: 'box', address: 'me@box', platform: 'linux', startup: { atBoot: 'no' }, ...o });
  const ran: string[] = [];
  let checked = 0;
  let code = 0;
  let out: { stdout: string; stderr: string } = { stdout: '', stderr: '' };
  const start = (rows: object[]) =>
    createHostStarter({
      registry: { list: () => rows as any, check: async () => void checked++ },
      channel: async (address: string, command: string) => (ran.push(`${address} ${command}`), { code, ...out }),
    });
  await start([row()])('h1');
  assert.deepEqual(ran, [`me@box ${START}`]);
  assert.equal(checked, 1);
  assert.match(START, /uname -s/, 'the machine says which system it is');
  await assert.rejects(start([row()])('nope'), { code: 'unknown_machine' });
  await assert.rejects(start([row({ address: 'relay:abc' })])('h1'), { code: 'no_ssh', message: /reached only through the relay/ });
  await assert.rejects(start([row({ platform: 'darwin', startup: { atBoot: 'yes' } })])('h1'), {
    code: 'needs_admin',
    message: /administrator/,
  });
  code = 1;
  out = { stdout: '', stderr: 'launchctl: Bootstrap failed\n5: Input/output error' };
  await assert.rejects(start([row()])('h1'), {
    code: 'start_failed',
    message: 'Could not start the Host on box: launchctl: Bootstrap failed 5: Input/output error',
  });
  out = { stdout: '', stderr: '' };
  await assert.rejects(start([row()])('h1'), { message: 'Could not start the Host on box.' });
  assert.equal(checked, 1, 'a failed start does not ask again');
});

test("main's list carries hostStopped, and startHost runs the start command on the machine through the service's own ssh, only while Host access is open", async (t) => {
  const clock = installFakeClock(t, 1_000_000);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stopped-host-svc-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  let up = true;
  const registry = createRegistry({
    file: path.join(d, 'host-registry.json'),
    status: async () => {
      if (!up) throw new Error('The machine closed the connection.');
      return { harnesses: [{ id: 'claude', detected: true, signedIn: true }], capabilities: {} };
    },
    explain: async () => 'host-stopped',
    report: () => undefined,
  });
  const ran: string[] = [];
  let allowed = true;
  const machines = createMachines({
    dir: d,
    root: d,
    allowed: () => allowed,
    watch: () => () => undefined,
    call: async () => ({ harnesses: [], capabilities: {} }),
    onChange: () => undefined,
    onStep: () => undefined,
    installer: { install: async () => ({ ok: false }) },
    channel: async (address: string, command: string) => (ran.push(`${address} ${command}`), { code: 0, stdout: '', stderr: '' }),
    registry,
  });
  t.after(() => machines.dispose());
  registry.add({ id: 'h1', name: 'box', address: 'me@box', socketPath: '/run/host.sock' });
  await registry.check();
  assert.equal('hostStopped' in machines.list().machines[0], false, 'a machine that answers is not stopped');
  up = false;
  clock.advance(100_000);
  await registry.check();
  await new Promise((r) => setImmediate(r));
  assert.equal(machines.list().machines[0].hostStopped, true);
  await machines.startHost('h1');
  assert.deepEqual(ran, [`me@box ${START}`]);
  allowed = false;
  await assert.rejects(async () => machines.startHost('h1'), { code: 'not_allowed' });
  assert.equal(ran.length, 1, 'nothing runs while Host access is off');
});
