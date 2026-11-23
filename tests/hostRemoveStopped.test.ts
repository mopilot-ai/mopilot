// Remove on a machine whose Host is stopped but whose ssh answers (#5155), through the real ssh channel and a fake `ssh` that runs commands against a temp home: the Host and its files are deleted exactly as when it runs, nothing of the person's or another install's goes, a link is removed as a link, a machine that does not answer is sent nothing destructive, and two rows naming one Host never delete it under the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fakeSshMachines, listing, dataDirOf } from './support/fakeSshMachines.ts';
import { useFakeClock } from './support/ports/clock.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createSshChannel } = require('../electron/host/sshChannel.cjs');
const { createHostUninstaller, PURGE } = require('../electron/host/uninstallHost.cjs');

const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
const row = (address: string, o: Record<string, unknown> = {}) => ({
  id: `ssh:${address}`,
  name: address,
  address,
  status: 'offline', // a stopped Host does not answer its heartbeat
  platform,
  startup: { atBoot: 'no' },
  hostKey: '',
  identity: '',
  ...o,
});

function world() {
  const fx = fakeSshMachines(platform);
  const rows: ReturnType<typeof row>[] = [];
  const channel = createSshChannel({ sshBin: fx.sshBin, timeoutMs: 20_000 });
  const u = createHostUninstaller({ registry: { list: () => rows as any }, channel, call: async () => ({ idle: true }) });
  return { fx, rows, u };
}
/** What `seedHost` leaves that is not the Host's own, which Remove must never take. */
const KEPT = [
  '.config/other/keep',
  '.local/share/mopilot-host-other/keep',
  '.mopilot-host-keep/x',
  'Documents/notes.txt',
  'Library/Application Support/mopilot-host-other/keep',
  'second-install/config/host-id',
];

test('a stopped Host with ssh up: Remove deletes the Host, its data and config, and nothing else', async (t) => {
  const w = world();
  t.after(w.fx.dispose);
  const home = w.fx.add('me@box', { running: false });
  w.rows.push(row('me@box'));
  assert.deepEqual(await w.u.plan('ssh:me@box'), {
    ssh: true,
    reachable: true,
    online: false,
    // the app cannot tell a stopped Host from one that is wedged or cut off, so the sheet says a turn may run
    busy: 'unknown',
    daemon: false,
    unsure: false,
    shared: '',
    why: '',
  });
  assert.deepEqual(await w.u.uninstall('ssh:me@box', ''), { left: '' });
  assert.deepEqual(listing(home), KEPT);
  assert.ok(!fs.existsSync(path.join(home, '.mopilot-host')) && !fs.existsSync(dataDirOf(home, platform)));
});

test('a running Host is handled the same way, and a Host that answers can be busy', async (t) => {
  const w = world();
  t.after(w.fx.dispose);
  const home = w.fx.add('me@box', { running: true });
  w.rows.push(row('me@box', { status: 'online' }));
  assert.equal((await w.u.plan('ssh:me@box')).online, true);
  assert.deepEqual(await w.u.uninstall('ssh:me@box', ''), { left: '' });
  assert.deepEqual(listing(home), KEPT);
});

test('a machine whose Host was never installed or lost its tree still has its data and config deleted', async (t) => {
  const w = world();
  t.after(w.fx.dispose);
  const home = w.fx.add('me@box', { running: false });
  fs.rmSync(path.join(home, '.mopilot-host'), { recursive: true });
  w.rows.push(row('me@box'));
  assert.deepEqual(await w.u.uninstall('ssh:me@box', ''), { left: '' });
  assert.deepEqual(listing(home), KEPT);
});

test('a Host whose own uninstall fails keeps its files and says why', async (t) => {
  const w = world();
  t.after(w.fx.dispose);
  const home = w.fx.add('me@box', { running: true });
  fs.writeFileSync(
    path.join(home, '.mopilot-host', 'current', 'host', 'bin', 'mopilot-host.mjs'),
    'process.stderr.write("no unit\\n"); process.exit(1);',
  );
  w.rows.push(row('me@box', { status: 'online' }));
  await assert.rejects(w.u.uninstall('ssh:me@box', ''), /no unit/);
  assert.ok(fs.existsSync(dataDirOf(home, platform)));
});

test('a machine that does not answer (refused, denied, hanging) is not reachable and is sent nothing destructive', async (t) => {
  const clock = useFakeClock(t);
  const w = world();
  t.after(w.fx.dispose);
  const home = w.fx.add('me@box', { mode: 'refused' });
  w.rows.push(row('me@box'));
  assert.equal((await w.u.plan('ssh:me@box')).reachable, false);
  w.fx.set('me@box', 'denied');
  assert.equal((await w.u.plan('ssh:me@box')).reachable, false);
  assert.deepEqual(
    w.fx.commands('me@box').map((c) => c.command),
    ['true', 'true'],
    'only the question went out',
  );
  assert.ok(fs.existsSync(dataDirOf(home, platform)) && fs.existsSync(path.join(home, '.mopilot-host')), 'nothing was deleted');
  // ssh that never answers: the question is bounded
  w.fx.set('me@box', 'hang');
  const asking = w.u.plan('ssh:me@box');
  await waitFor(() => w.fx.commands('me@box').filter((c) => c.command === 'true').length >= 3, 'the hanging probe to start');
  clock.advance(10_000);
  assert.equal((await asking).reachable, false);
  clock.advance(120_000); // the channel's own timeout ends the stuck ssh
});

test('ssh that drops after the question: the uninstall is cut off and says so, with nothing deleted', async (t) => {
  const w = world();
  t.after(w.fx.dispose);
  const home = w.fx.add('me@box', { running: true });
  w.rows.push(row('me@box', { status: 'online' }));
  assert.equal((await w.u.plan('ssh:me@box')).reachable, true);
  w.fx.set('me@box', 'refused');
  await assert.rejects(
    w.u.uninstall('ssh:me@box', ''),
    (e: any) => e.code === 'uninstall_cut_off' && /may be stopped and some files may remain/.test(e.message),
  );
  assert.ok(fs.existsSync(dataDirOf(home, platform)), 'nothing was deleted');
});

test('only the ssh user’s own fixed paths go: a link is removed as a link, another user and another install stay', async (t) => {
  const w = world();
  t.after(w.fx.dispose);
  const home = w.fx.add('me@box', { running: false });
  const bob = w.fx.add('bob@box', { running: true });
  // the install tree is a link to a folder of the person's own
  const precious = path.join(home, 'precious');
  fs.mkdirSync(precious);
  fs.writeFileSync(path.join(precious, 'thesis.txt'), 'x');
  fs.rmSync(path.join(home, '.mopilot-host'), { recursive: true });
  fs.symlinkSync(precious, path.join(home, '.mopilot-host'));
  const before = listing(bob);
  w.rows.push(row('me@box', { hostKey: 'aa'.repeat(16) }), row('bob@box', { status: 'online', hostKey: 'bb'.repeat(16) }));
  assert.deepEqual(await w.u.uninstall('ssh:me@box', ''), { left: '' });
  assert.ok(!fs.existsSync(path.join(home, '.mopilot-host')), 'the link is gone');
  assert.deepEqual(listing(precious), ['thesis.txt'], 'its target is not followed');
  assert.deepEqual(listing(bob), before, 'another user’s Host is untouched');
  assert.ok(listing(home).includes('second-install/config/host-id'), 'a second install with its own data dir stays');
  // the command removes only three quoted paths, each ending in mopilot-host, built from HOME and the XDG roots: nothing a caller supplies
  const targets = PURGE.split('rm -rf ')[1].match(/"[^"]+"/g);
  assert.deepEqual(
    targets?.map((p: string) => p.replace(/^"\$HOME\/\./, '"').replace(/^"\$\{XDG_CONFIG_HOME:-\$HOME\/\.config\}\//, '"')),
    ['"mopilot-host"', '"$data"', '"mopilot-host"'],
  );
});

test('the purge runs only when every other row is proved a different Host: same address or key, or a missing key, touch nothing', async (t) => {
  const w = world();
  t.after(w.fx.dispose);
  const home = w.fx.add('me@box', { running: true });
  w.fx.alias('me@10.0.0.7', 'me@box');
  const key = (c: string) => c.repeat(16);
  const sent = () => w.fx.commands().length;
  const stays = async (id: string, why: string, other: string) => {
    assert.deepEqual(await w.u.plan(id), { ...(await w.u.plan(id)), shared: other, why });
    const before = sent();
    assert.deepEqual(await w.u.uninstall(id, ''), { left: 'shared', shared: other, why });
    assert.equal(sent(), before, 'nothing was sent to the machine');
    assert.ok(fs.existsSync(dataDirOf(home, platform)) && fs.existsSync(path.join(home, '.mopilot-host')), 'the Host stays');
  };
  // the same key, spelled two ways
  w.rows.push(row('me@box', { hostKey: key('ab'), name: 'box' }), row('me@10.0.0.7', { hostKey: key('ab'), name: 'box (ip)' }));
  await stays('ssh:me@10.0.0.7', 'same', 'box');
  await stays('ssh:me@box', 'same', 'box (ip)');
  // the same address twice
  w.rows.splice(0, 2, row('me@box', { name: 'a', hostKey: key('ab') }), row('me@box', { id: 'ssh:dup', name: 'b', hostKey: key('cd') }));
  await stays('ssh:me@box', 'same', 'b');
  // this row never pinned a key, another row exists
  w.rows.splice(0, 2, row('me@box', { name: 'a' }), row('me@10.0.0.7', { name: 'b', hostKey: key('cd') }));
  await stays('ssh:me@box', 'unknown', 'b');
  // neither row ever pinned a key: they cannot be told apart, and are not called the same Host
  w.rows.splice(0, 2, row('me@box', { name: 'a' }), row('me@10.0.0.7', { name: 'b' }));
  await stays('ssh:me@box', 'unknown', 'b');
  // this row is pinned, the other is not
  w.rows.splice(0, 2, row('me@box', { name: 'a', hostKey: key('ab') }), row('me@10.0.0.7', { name: 'b' }));
  await stays('ssh:me@box', 'unknown', 'b');
  // a relay row with the same key
  w.rows.splice(
    0,
    2,
    row('me@box', { name: 'a', hostKey: key('ab') }),
    row('relay:h_9', { id: 'relay:h_9', address: 'relay:h_9', name: 'r', hostKey: key('ab') }),
  );
  await stays('ssh:me@box', 'same', 'r');
  // an unknown row listed before a same one: the same one is named
  w.rows.splice(
    0,
    2,
    row('me@box', { name: 'a', hostKey: key('ab') }),
    row('x@y', { name: 'u' }),
    row('me@10.0.0.7', { name: 's', hostKey: key('ab') }),
  );
  assert.equal((await w.u.plan('ssh:me@box')).shared, 's');
  w.rows.length = 0;
  // two pinned rows with different keys: proved distinct, so the purge runs
  w.rows.push(row('me@box', { name: 'a', hostKey: key('ab') }), row('me@10.0.0.7', { name: 'b', hostKey: key('cd') }));
  assert.deepEqual([(await w.u.plan('ssh:me@box')).shared, (await w.u.plan('ssh:me@box')).why], ['', '']);
  assert.deepEqual(await w.u.uninstall('ssh:me@box', ''), { left: '' });
  assert.deepEqual(listing(home), KEPT);
});

test('the only row is purged whatever its Host key', async (t) => {
  const w = world();
  t.after(w.fx.dispose);
  const home = w.fx.add('me@box', { running: true });
  w.rows.push(row('me@box'));
  assert.deepEqual(await w.u.uninstall('ssh:me@box', ''), { left: '' });
  assert.deepEqual(listing(home), KEPT);
});

test('a boot daemon without the password and a Mac that cannot say are left; a machine added by command is refused', async (t) => {
  const w = world();
  t.after(w.fx.dispose);
  const home = w.fx.add('me@box', { running: true });
  w.rows.push(
    row('me@box', { platform: 'darwin', startup: { atBoot: 'yes' }, status: 'online', hostKey: 'aa'.repeat(16) }),
    row('me@mac', { platform: 'darwin', startup: { atBoot: 'unknown' }, status: 'online', hostKey: 'bb'.repeat(16) }),
    row('relay:h_1', { address: 'relay:h_1', id: 'relay:h_1', hostKey: 'cc'.repeat(16) }),
  );
  assert.deepEqual(await w.u.uninstall('ssh:me@box', ''), { left: 'daemon' });
  assert.deepEqual(await w.u.uninstall('ssh:me@mac', ''), { left: 'unsure' });
  assert.ok(fs.existsSync(dataDirOf(home, platform)));
  const relay = await w.u.plan('relay:h_1');
  assert.deepEqual([relay.ssh, relay.shared, relay.why], [false, '', '']);
  await assert.rejects(w.u.uninstall('relay:h_1', ''), (e: any) => e.code === 'unsupported');
  await assert.rejects(w.u.uninstall('ssh:none', ''), (e: any) => e.code === 'unknown_machine');
});
