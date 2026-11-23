// Remove on a machine that answers (electron/host/uninstallHost.cjs): what the sheet asks first (ssh, a turn running, a boot daemon) and the uninstall itself: the service stopped, the files deleted, a boot daemon only with the administrator password and otherwise left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHostUninstaller, PURGE } = require('../electron/host/uninstallHost.cjs');

type Row = { id: string; address: string; status: string; platform: string; startup: { atBoot: string } };
const row = (o: Partial<Row> = {}): Row => ({
  id: 'ssh:me@box',
  address: 'me@box',
  status: 'online',
  platform: 'darwin',
  startup: { atBoot: 'no' },
  ...o,
});

function world(
  o: { row?: Row; idle?: unknown; callFails?: boolean; results?: Record<string, { code: number; stderr?: string; stdout?: string }> } = {},
) {
  const ran: { command: string; input?: string }[] = [];
  const r = o.row ?? row();
  const u = createHostUninstaller({
    registry: { list: () => [r] },
    channel: async (_d: string, command: string, input?: Buffer) => {
      ran.push({ command, input: input?.toString() });
      const key = Object.keys(o.results ?? {}).find((k) => command.includes(k));
      const hit = key ? o.results![key] : { code: 0 };
      return { code: hit.code, stdout: hit.stdout ?? (command.includes('sudo') ? 'turned-off' : ''), stderr: hit.stderr ?? '' };
    },
    call: async () => {
      if (o.callFails) throw new Error('unknown method');
      return o.idle;
    },
  });
  return { u, ran };
}

test('plan: a turn running there, none, and an older Host that cannot say', async () => {
  assert.deepEqual(await world({ idle: { idle: false } }).u.plan('ssh:me@box'), {
    ssh: true,
    reachable: true,
    online: true,
    busy: 'yes',
    daemon: false,
    unsure: false,
    shared: '',
    why: '',
  });
  assert.equal((await world({ idle: { idle: true } }).u.plan('ssh:me@box')).busy, 'no');
  assert.equal((await world({ callFails: true }).u.plan('ssh:me@box')).busy, 'unknown');
});

test('plan: a Host that does not answer is not asked about turns and may be running one, a relay-only machine is not probed, and a boot daemon is flagged', async () => {
  const off = await world({ row: row({ status: 'offline' }), callFails: true }).u.plan('ssh:me@box');
  // ssh answers but the Host does not: it may be wedged or cut off from this Mac rather than stopped, so a turn may run there
  assert.deepEqual(off, { ssh: true, reachable: true, online: false, busy: 'unknown', daemon: false, unsure: false, shared: '', why: '' });
  const relay = world({ row: row({ address: 'relay:abc' }) });
  assert.equal((await relay.u.plan('ssh:me@box')).ssh, false);
  assert.deepEqual(relay.ran, [], 'nothing is asked of a machine with no ssh');
  const down = await world({ row: row({ platform: 'linux' }), results: { true: { code: 255 } } }).u.plan('ssh:me@box');
  assert.deepEqual([down.reachable, down.online], [false, false]);
  assert.equal((await world({ row: row({ startup: { atBoot: 'unknown' } }) }).u.plan('ssh:me@box')).unsure, true);
  assert.equal((await world({ row: row({ startup: { atBoot: 'yes' } }), idle: { idle: true } }).u.plan('ssh:me@box')).daemon, true);
});

test('an unknown machine is refused', async () => {
  const u = createHostUninstaller({
    registry: { list: () => [] },
    channel: async () => ({ code: 0, stdout: '', stderr: '' }),
    call: async () => ({}),
  });
  await assert.rejects(u.uninstall('ssh:none', ''), (e: any) => e.code === 'unknown_machine');
});

test('uninstall stops the Host and deletes its files', async () => {
  const w = world();
  assert.deepEqual(await w.u.uninstall('ssh:me@box', ''), { left: '' });
  assert.equal(w.ran.length, 2);
  assert.match(w.ran[0].command, /uninstall$/);
  assert.equal(w.ran[1].command, PURGE);
  assert.match(PURGE, /\.mopilot-host/);
});

test('a boot daemon: without the password nothing runs and it is left; with it the daemon is turned off first', async () => {
  const daemon = row({ startup: { atBoot: 'yes' } });
  const none = world({ row: daemon });
  assert.deepEqual(await none.u.uninstall('ssh:me@box', ''), { left: 'daemon' });
  assert.equal(none.ran.length, 0);
  const w = world({ row: daemon });
  assert.deepEqual(await w.u.uninstall('ssh:me@box', 'pw'), { left: '' });
  assert.match(w.ran[0].command, /sudo -S/);
  assert.equal(w.ran[0].input, 'pw\n');
  assert.equal(w.ran.length, 3);
});

test('a wrong password stops before the Host is touched', async () => {
  const w = world({ row: row({ startup: { atBoot: 'yes' } }), results: { sudo: { code: 1, stderr: 'Sorry, try again.' } } });
  await assert.rejects(w.u.uninstall('ssh:me@box', 'bad'), (e: any) => e.code === 'wrong_password');
  assert.equal(w.ran.length, 1);
});

test('failures say what is still on the machine', async () => {
  const stop = world({ results: { uninstall: { code: 1, stderr: 'a\nno bin' } } });
  await assert.rejects(stop.u.uninstall('ssh:me@box', ''), (e: any) => e.code === 'uninstall_failed' && e.message === 'no bin');
  const quiet = world({ results: { uninstall: { code: 1 } } });
  await assert.rejects(quiet.u.uninstall('ssh:me@box', ''), /couldn’t be stopped/);
  const files = world({ results: { 'rm -rf': { code: 1 } } });
  await assert.rejects(files.u.uninstall('ssh:me@box', ''), /files couldn’t be deleted/);
  await assert.rejects(world({ row: row({ address: 'relay:x' }) }).u.uninstall('ssh:me@box', ''), (e: any) => e.code === 'unsupported');
});

test('on Linux a Host that starts at boot is the user’s own lingering service: no password, and it is uninstalled', async () => {
  const linux = row({ platform: 'linux', startup: { atBoot: 'yes' } });
  assert.equal((await world({ row: linux, idle: { idle: true } }).u.plan('ssh:me@box')).daemon, false);
  const w = world({ row: linux });
  assert.deepEqual(await w.u.uninstall('ssh:me@box', ''), { left: '' });
  assert.equal(w.ran.length, 2);
});

test('ssh cut off or out of time mid-way is reported as such and never as removed', async () => {
  const cut = /may be stopped and some files may remain/;
  for (const key of ['uninstall', 'rm -rf']) {
    for (const code of [255, -1]) {
      const w = world({ results: { [key]: { code } } });
      await assert.rejects(w.u.uninstall('ssh:me@box', ''), (e: any) => e.code === 'uninstall_cut_off' && cut.test(e.message));
    }
  }
  // the Host's uninstall failed, then ssh dropped while asking whether a tree is there
  const tree = world({ results: { uninstall: { code: 1 }, 'test -e': { code: 255 } } });
  await assert.rejects(tree.u.uninstall('ssh:me@box', ''), (e: any) => e.code === 'uninstall_cut_off');
  // a machine with no Host installed still has its files deleted
  const bare = world({ results: { uninstall: { code: 127 }, 'test -e': { code: 1 } } });
  assert.deepEqual(await bare.u.uninstall('ssh:me@box', ''), { left: '' });
  assert.equal(bare.ran.at(-1)?.command, PURGE);
});

test('a Mac that never said whether its Host starts at boot, or whose Host another row uses, is not touched', async () => {
  const unsure = world({ row: row({ startup: { atBoot: 'unknown' } }) });
  assert.deepEqual(await unsure.u.uninstall('ssh:me@box', ''), { left: 'unsure' });
  assert.deepEqual(unsure.ran, []);
  // this Mac's own Host is never "unsure": its Remove must keep working
  const local = world({ row: row({ id: 'this-mac-host', address: 'local:me', startup: { atBoot: 'unknown' } }) });
  assert.deepEqual(await local.u.uninstall('this-mac-host', ''), { left: '' });
});

test('a channel that throws counts as not reachable', async () => {
  const u = createHostUninstaller({
    registry: { list: () => [row()] },
    channel: async () => {
      throw new Error('spawn failed');
    },
    call: async () => ({}),
  });
  assert.equal((await u.plan('ssh:me@box')).reachable, false);
});
