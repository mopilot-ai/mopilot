// Keep running after restart from the app (electron/host/startAtBoot.cjs) and what it changes in the registry (registry.cjs) and the sign-in wait (signinWait.cjs): the administrator password reaches only sudo's standard input, root runs only the launchDaemon.mjs scripts, sudo's refusals are said in the person's words, the Host must answer as the new service, one change per machine at a time; a Host that starts at boot waits for nobody, and a FileVault Mac that refuses the key is locked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { useFakeProc as installFakeProc } from './support/ports/proc.ts';
import { waitFor } from './support/waitFor.ts';
const require = createRequire(import.meta.url);
const { createStartAtBoot, sudoRefusal } = require('../electron/host/startAtBoot.cjs');
const { HOST_CLI } = require('../electron/host/install.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');
const { createSigninWait, COMMAND } = require('../electron/host/signinWait.cjs');
// @ts-ignore: plain ESM without declarations
import { renderDaemonPlist, sudoCommand, turnOffScript, turnOnScript } from '../shared/host/launchDaemon.mjs';

const info = {
  user: 'jane',
  home: '/Users/jane',
  node: '/Users/jane/.mopilot-host/runtime/current/bin/node',
  bin: '/Users/jane/.mopilot-host/current/host/bin/mopilot-host.mjs',
  dataDir: '/Users/jane/Library/Application Support/mopilot-host',
  path: '/usr/bin',
};
const mac = { id: 'ssh:jane@mini', address: 'jane@mini', identity: '', platform: 'darwin' };
type Reply = { code?: number; stdout?: string; stderr?: string };

/** A Mac over ssh: `--print-daemon` says `info`, sudo takes `password` (a wrong one is refused as sudo does), and the Host's status says what the last change made it. */
function world(o: { password?: string; replies?: Record<string, Reply | ((input?: Buffer) => Reply)>; records?: any[] } = {}) {
  const ran: { record: any; command: string; input?: Buffer }[] = [];
  let atBoot = 'no';
  const replies: Record<string, Reply | ((input?: Buffer) => Reply)> = {
    '--print-daemon': { stdout: `${JSON.stringify(info)}\n` },
    '/usr/bin/sudo': (input) => {
      if (input?.toString('utf8') !== `${o.password ?? 'pw'}\n`)
        return { code: 1, stderr: 'Sorry, try again.\nsudo: 1 incorrect password attempt' };
      atBoot = ran.at(-1)?.command.includes('turned-on') ? 'yes' : 'no';
      return { stdout: atBoot === 'yes' ? 'turned-on\n' : 'turned-off\n' };
    },
    'rm -f': {},
    'install >/dev/null': { stdout: '' },
    status: () => ({ stdout: JSON.stringify({ running: true, startup: { atBoot, fileVault: 'off' } }) }),
    ...o.replies,
  };
  const run = async (record: any, command: string, input?: Buffer) => {
    ran.push({ record, command, input });
    const key = Object.keys(replies).find((k) => command.includes(k));
    const raw = key === undefined ? { code: 127, stderr: 'not found' } : replies[key];
    const r = typeof raw === 'function' ? raw(input) : raw;
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const waits: number[] = [];
  const boot = createStartAtBoot({
    registry: { list: () => o.records ?? [mac] },
    run,
    wait: async (ms: number) => void waits.push(ms),
  });
  return { boot, ran, waits, commands: () => ran.map((r) => r.command) };
}

test('turning on: the plist from the Host, the password only on sudo’s standard input, the agent removed, and the Host answers as the daemon', async () => {
  const w = world();
  await w.boot.set(mac.id, true, 'pw');
  const [ask, root, rm, status] = w.ran;
  assert.equal(ask.command, `${HOST_CLI} install --print-daemon`);
  // the root script is exactly the one launchDaemon.mjs builds, for the user the Host named, checked against sudo's own user
  const script = turnOnScript({ plist: renderDaemonPlist(info), user: 'jane', sameUser: true });
  assert.equal(root.command, `/usr/bin/sudo -S -k -p '' /bin/sh -c '${script.replace(/'/g, `'\\''`)}'`);
  assert.deepEqual(root.input, Buffer.from('pw\n'));
  // the password is in no command line
  assert.ok(w.ran.every((r) => !r.command.includes('pw\n') && !/\bpw\b/.test(r.command)));
  assert.equal(rm.command, 'rm -f "$HOME/Library/LaunchAgents/ai.mopilot.host.plist"');
  assert.equal(status.command, `${HOST_CLI} status`);
  assert.equal(w.ran.length, 4);
  assert.ok(w.ran.every((r) => r.record === mac));
});

test('turning off: root unloads the daemon, the user’s agent is written and started again, and the Host answers as the agent', async () => {
  const w = world();
  await w.boot.set(mac.id, true, 'pw');
  w.ran.length = 0;
  await w.boot.set(mac.id, false, 'pw');
  assert.ok(w.ran[0].command.includes(turnOffScript().replace(/'/g, `'\\''`)));
  assert.match(w.ran[1].command, /mopilot-host\.mjs" install >\/dev\/null && \{ if \[ -f \/Library\/LaunchDaemons/);
  assert.match(w.ran[1].command, /\|\| \{ launchctl print "gui\/\$\(id -u\)" >\/dev\/null 2>&1 && exit 1; echo starts-at-sign-in; \}/);
  assert.equal(w.ran.at(-1)?.command, `${HOST_CLI} status`);
});

test('turning off with nobody signed in: the agent waits for a sign-in, so there is no Host to ask', async () => {
  const w = world({ replies: { 'install >/dev/null': { stdout: 'starts-at-sign-in\n' } } });
  await w.boot.set(mac.id, false, 'pw');
  assert.equal(w.ran.length, 2);
  const failing = world({ replies: { 'install >/dev/null': { code: 1, stderr: 'Bootstrap failed: 5\nlaunchd refused' } } });
  await assert.rejects(failing.boot.set(mac.id, false, 'pw'), { code: 'boot_change_failed', message: 'launchd refused' });
  const silent = world({ replies: { 'install >/dev/null': { code: 1 } } });
  await assert.rejects(silent.boot.set(mac.id, false, 'pw'), { message: 'The Host couldn’t start again.' });
});

test('sudo’s refusals in the person’s words; any other failure says the machine’s last line', async () => {
  await assert.rejects(world().boot.set(mac.id, true, 'wrong'), { code: 'wrong_password', message: 'That password didn’t work.' });
  const notAdmin = world({ replies: { '/usr/bin/sudo': { code: 1, stderr: 'jane is not in the sudoers file.' } } });
  await assert.rejects(notAdmin.boot.set(mac.id, true, 'pw'), { code: 'not_admin', message: 'Needs an administrator of this machine.' });
  const other = world({ replies: { '/usr/bin/sudo': { code: 4, stderr: 'plutil: bad\nmv: denied\n' } } });
  await assert.rejects(other.boot.set(mac.id, true, 'pw'), { code: 'boot_change_failed', message: 'mv: denied' });
  // a script that ran but did not say it was done is a failure too
  const quiet = world({ replies: { '/usr/bin/sudo': { code: 0, stdout: '' } } });
  await assert.rejects(quiet.boot.set(mac.id, true, 'pw'), { message: 'The machine refused the change.' });
  assert.equal(sudoRefusal('anything else'), '');
  assert.throws(() => sudoRefusal('user may not run sudo on mini'), { code: 'not_admin' });
});

test('no password, or one with a line break, never reaches the machine', async () => {
  for (const password of ['', 'a\nb', 'a\rb', 7 as any]) {
    const w = world();
    await assert.rejects(w.boot.set(mac.id, true, password), { code: 'invalid', message: 'Enter the password.' });
    assert.ok(!w.commands().some((c) => c.includes('sudo')));
  }
});

test('a Host that cannot say what the daemon needs is too old: nothing runs as root', async () => {
  for (const reply of [{ code: 1, stderr: 'Usage' }, { stdout: '{"user":"root"}' }]) {
    const w = world({ replies: { '--print-daemon': reply } });
    await assert.rejects(w.boot.set(mac.id, true, 'pw'), { code: 'unsupported', message: 'Update this machine’s Host first.' });
    assert.ok(!w.commands().some((c) => c.includes('sudo')));
  }
});

test('the Host must come back as the new service: asked again each second, and a change that never shows is a failure', async () => {
  let n = 0;
  const w = world({
    replies: {
      status: () =>
        ++n < 3
          ? { stdout: n === 1 ? 'not json' : JSON.stringify({ running: true, startup: { atBoot: 'no' } }) }
          : { stdout: JSON.stringify({ running: true, startup: { atBoot: 'yes' } }) },
    },
  });
  await w.boot.set(mac.id, true, 'pw');
  assert.deepEqual(w.waits, [1000, 1000]);
  const never = world({ replies: { status: { stdout: JSON.stringify({ running: false }) } } });
  await assert.rejects(never.boot.set(mac.id, true, 'pw'), {
    code: 'boot_change_failed',
    message: 'The Host didn’t come back. Try again.',
  });
  assert.equal(never.waits.length, 14);
  // a Host that never printed a status it could read: the failure keeps why as its cause
  const garbled = world({ replies: { status: { stdout: 'not json' } } });
  await assert.rejects(garbled.boot.set(mac.id, true, 'pw'), (e: any) => e.code === 'boot_change_failed' && e.cause instanceof SyntaxError);
  await never.boot.set(mac.id, true, 'pw').catch((e: any) => assert.equal(e.cause, undefined));
});

test('only a Mac in the registry reached over SSH; one change per machine at a time', async () => {
  const w = world({ records: [mac, { ...mac, id: 'relay:x', address: 'relay:x' }, { ...mac, id: 'ssh:lin', platform: 'linux' }] });
  assert.throws(() => w.boot.set('nope', true, 'pw'), { code: 'unknown_machine' });
  assert.throws(() => w.boot.set('relay:x', true, 'pw'), {
    code: 'unsupported',
    message: 'Only a machine added over SSH can do this from here.',
  });
  assert.throws(() => w.boot.set('ssh:lin', true, 'pw'), { code: 'unsupported', message: 'Only a Mac needs this.' });
  const first = w.boot.set(mac.id, true, 'pw');
  await assert.rejects(w.boot.set(mac.id, true, 'pw'), { code: 'busy' });
  await first;
  // once it ended, the next one runs
  await w.boot.set(mac.id, false, 'pw');
});

test('the command to run at the machine: the same root script, for an administrator who may not be the user', async () => {
  const w = world();
  assert.equal(await w.boot.command(mac.id), sudoCommand(turnOnScript({ plist: renderDaemonPlist(info), user: 'jane', sameUser: false })));
  assert.ok(!w.commands().some((c) => c.includes('sudo')), 'nothing runs as root to make the command');
});

test('the default ssh channel never prompts and signs in with the machine’s key', async (t) => {
  const spawned: { bin: string; args: string[] }[] = [];
  installFakeProc(t, {
    spawn: (bin: string, args: string[]) => {
      spawned.push({ bin, args });
      const child = Object.assign(new EventEmitter(), {
        pid: 1,
        stdin: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(info)));
        child.emit('close', 0);
      });
      return child;
    },
  });
  const boot = createStartAtBoot({ registry: { list: () => [{ ...mac, identity: '/keys/id_mini' }] } });
  assert.match(await boot.command(mac.id), /^sudo \/bin\/sh -c /);
  const { bin, args } = spawned[0];
  assert.equal(bin, 'ssh');
  assert.ok(args.includes('BatchMode=yes'), 'never prompts');
  assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', '/keys/id_mini']);
  assert.deepEqual(args.slice(-3), ['--', 'jane@mini', `${HOST_CLI} install --print-daemon`]);
});

test('the default wait between status asks is the clock’s', async (t) => {
  const clock = installFakeClock(t, 0);
  const boot = createStartAtBoot({
    registry: { list: () => [mac] },
    run: async (_r: any, command: string) => ({
      code: 0,
      stdout: command.includes('/usr/bin/sudo') ? 'turned-off' : command.includes('install >') ? '' : '{}',
      stderr: '',
    }),
  });
  let settled = false;
  const p = boot.set(mac.id, false, 'pw').finally(() => (settled = true));
  p.catch(() => undefined);
  // each check moves the fake clock on a second, so the default wait between the Host's answers elapses
  await waitFor(() => settled, 'the switch to give up waiting for the Host', { step: () => clock.advance(1000) });
  await assert.rejects(p, { code: 'boot_change_failed' });
});

const regFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'registry-boot-')), 'hosts.json');

test('the registry keeps what the Host said of starting at boot and its system, from status, add and the file; anything else is unknown', async (t) => {
  installFakeClock(t, 1_000_000);
  const file = regFile();
  let said: any = {
    harnesses: [{ id: 'claude', detected: true, signedIn: true }],
    capabilities: {},
    platform: 'darwin',
    startup: { atBoot: 'yes', fileVault: 'on' },
  };
  const registry = createRegistry({ file, status: async () => said });
  t.after(() => registry.dispose());
  registry.add({ id: 'h1', name: 'h1', address: 'me@h1', startup: { atBoot: 'no', fileVault: 'off' }, platform: 'linux' });
  assert.deepEqual([registry.list()[0].startup, registry.list()[0].platform], [{ atBoot: 'no', fileVault: 'off' }, 'linux']);
  await registry.check();
  assert.deepEqual([registry.list()[0].startup, registry.list()[0].platform], [{ atBoot: 'yes', fileVault: 'on' }, 'darwin']);
  // an older Host says nothing; a foreign value is not kept
  said = { ...said, platform: 'win32', startup: 'yes' };
  await registry.check();
  assert.deepEqual([registry.list()[0].startup, registry.list()[0].platform], [{ atBoot: 'unknown', fileVault: 'unknown' }, '']);
  said = { ...said, startup: { atBoot: 'maybe', fileVault: 1 } };
  await registry.check();
  assert.deepEqual(registry.list()[0].startup, { atBoot: 'unknown', fileVault: 'unknown' });
  registry.add({ id: 'h2', name: 'h2', address: 'me@h2' });
  // read back from the file
  const again = createRegistry({ file, status: async () => said });
  t.after(() => again.dispose());
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.hosts[0].startup = { atBoot: 'yes', fileVault: 'off' };
  saved.hosts[0].platform = 'darwin';
  fs.writeFileSync(file, JSON.stringify(saved));
  const reread = createRegistry({ file, status: async () => said });
  t.after(() => reread.dispose());
  assert.deepEqual([reread.list()[0].startup, reread.list()[0].platform], [{ atBoot: 'yes', fileVault: 'off' }, 'darwin']);
  assert.deepEqual(reread.list()[1].startup, { atBoot: 'unknown', fileVault: 'unknown' });
});

test('a machine that is locked by FileVault waits for its unlock, said so when its key is refused; a Host that starts at boot waits for nobody', async (t) => {
  installFakeClock(t, 5_000_000);
  const replies: any[] = [];
  const wait = createSigninWait({ run: async () => replies.shift() });
  const rec = { id: 'h1', address: 'me@mini', identity: '', lastHeartbeat: 1_000_000, startup: { atBoot: 'yes', fileVault: 'on' } };
  const denied = { code: 255, stdout: '', stderr: 'me@mini: Permission denied (publickey,password,keyboard-interactive).' };
  replies.push(denied);
  assert.equal(await wait(rec), 'locked');
  // a Host at boot whose machine answers: the console's owner says nothing, so nobody waits to sign in; the Host itself is what does not answer
  replies.push({ code: 0, stdout: 'root\nme\n{ sec = 6000, usec = 0 }\n' });
  assert.equal(await wait({ ...rec, id: 'h2' }), 'host-stopped');
  // FileVault off: a refused key is not a lock
  replies.push(denied);
  assert.equal(await wait({ ...rec, id: 'h3', startup: { atBoot: 'no', fileVault: 'off' } }), null);
  // a refusal without stderr, and a record from before this change, say nothing new
  replies.push({ code: 255, stdout: '' });
  assert.equal(await wait({ ...rec, id: 'h4' }), null);
  replies.push({ code: 0, stdout: 'root\nme\n{ sec = 6000, usec = 0 }\n' });
  const { startup: _drop, ...old } = rec;
  assert.equal(await wait({ ...old, id: 'h5' }), 'restarted');
  assert.equal(typeof COMMAND, 'string');
});
