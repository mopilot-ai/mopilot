// Adding a machine (electron/host/install.cjs) over a fake SSH channel: the Host tarball uploaded, checked against its SHA-256 and unpacked, every step with its output, rollback when a step fails, a repeated install, an npm package instead, overlapping requests, malformed replies (B1) and a real ssh child through the proc port (B2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock } from './support/ports/clock.ts';
import { useFakeProc } from './support/ports/proc.ts';
const require = createRequire(import.meta.url);
const { createInstaller, createSshChannel, validDestination } = require('../electron/host/install.cjs');

import { status, BYTES, SHA, dir, FILE, bundle, CLI, machine, added, registry, upto } from './support/host-install-kit.ts';

test('a fresh Linux machine: the tarball is uploaded, checked, unpacked and started, and the machine is recorded from the typed address with its socket (happy path)', async () => {
  added.length = 0;
  const m = machine();
  const events: string[] = [];
  const out = await createInstaller({ channel: m.channel, registry, bundle }).install('me@build.example', (s: any) =>
    events.push(`${s.id}:${s.state}`),
  );
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.steps.map((s: any) => s.id),
    ['connect', 'detect', 'node', 'prepare', 'upload', 'verify', 'unpack', 'unit', 'start', 'linger', 'status', 'pair'],
  );
  assert.ok(out.steps.every((s: any) => s.state === 'ok'));
  assert.equal(out.steps[0].output, 'Linux x86_64');
  assert.equal(out.steps[1].output, 'No Host on this machine yet.');
  assert.equal(out.steps[3].output, 'Host 1.2.3 for linux-x64-gnu');
  assert.match(out.steps[4].output, /1\.2\.3, 1 KB/);
  assert.equal(out.steps[5].output, `SHA-256 ${SHA.substring(0, 12)}…`);
  assert.deepEqual(events.slice(0, 4), ['connect:running', 'connect:ok', 'detect:running', 'detect:ok']);
  // the bytes went over standard input into a file named by the checksum, which was checked there, then unpacked and made current
  const upload = m.ran.find((r) => r.command.includes('cat >'));
  assert.deepEqual(upload?.input, BYTES);
  assert.match(upload?.command as string, new RegExp(`incoming/${SHA}\\.tgz`));
  assert.match(upto(m, 'sha256sum'), new RegExp(`"\\$h" = "${SHA}"`));
  assert.match(upto(m, 'tar -xzf'), new RegExp(`versions/${SHA}.*ln -sfn .*versions/${SHA}" ".*current"`));
  assert.ok(m.commands().includes(`${CLI} install`));
  assert.match(
    upto(m, 'systemctl --user enable'),
    /systemctl --user daemon-reload && systemctl --user enable mopilot-host && systemctl --user restart mopilot-host/,
  );
  assert.deepEqual(added, [
    {
      id: 'ssh:me@build.example',
      name: 'build.example',
      address: 'me@build.example',
      socketPath: status.socketPath,
      capabilities: status.capabilities,
      harnesses: status.harnesses,
      // no key step without key access: this Mac's own ssh setup
      identity: '',
      // whether it starts at boot, and its system, as the Host said
      startup: status.startup,
      platform: status.platform,
    },
  ]);
  assert.equal(out.rolledBack, false);
  // the code is a secret: it is in the result for the caller, never in a step the card shows
  assert.equal(out.pairingCode, 'ABCD-EFGH-JKMN');
  assert.ok(!JSON.stringify(out.steps).includes('ABCD'));
  assert.ok(!events.join().includes('ABCD'));
  assert.equal(out.steps.at(-1).output, 'A one-time pairing code was issued.');
  // nothing here needs npm on the machine
  assert.ok(!m.commands().some((c) => c.includes('npm')));
});

test('macOS starts the launchd agent', async () => {
  const m = machine({ 'uname -sm': { stdout: 'Darwin arm64\n' } });
  const out = await createInstaller({ channel: m.channel, bundle }).install('mac');
  assert.equal(out.ok, true);
  // registered in the user's GUI domain and started explicitly: over ssh launchd does not run it at load
  assert.match(
    upto(m, 'launchctl bootstrap'),
    /D=gui\/\$U.*launchctl bootstrap "\$D" "\$HOME\/Library\/LaunchAgents\/ai\.mopilot\.host\.plist" && launchctl kickstart -k "\$D\/ai\.mopilot\.host"/,
  );
  assert.equal(m.service.runningFrom, SHA);
});

test('a Host that prints no pairing code, or fails to, fails the install and rolls it back', async () => {
  for (const reply of [{ stdout: 'nothing' }, { code: 1, stderr: 'boom' }]) {
    const m = machine({ pair: reply });
    const out = await createInstaller({ channel: m.channel, registry, bundle }).install('me@box');
    assert.deepEqual([out.ok, out.failedStep, out.rolledBack], [false, 'pair', true]);
    assert.equal(out.pairingCode, undefined);
  }
});

test('a step that fails after the unit was written rolls the install back: service stopped, unit removed, and the files put back as this run found them', async () => {
  for (const [os, stop] of [
    ['Linux x86_64', /systemctl --user disable --now/],
    ['Darwin arm64', /launchctl bootout "\$D\/ai\.mopilot\.host"/],
  ] as const) {
    const m = machine({
      'uname -sm': { stdout: `${os}\n` },
      'systemctl --user enable': { code: 1, stderr: 'Failed to connect to bus' },
      'launchctl bootstrap': { code: 1, stderr: 'Load failed' },
    });
    const out = await createInstaller({ channel: m.channel, registry, bundle }).install('me@box');
    assert.equal(out.ok, false);
    assert.equal(out.failedStep, 'start');
    assert.match(out.error, /Failed to connect to bus|Load failed/);
    assert.equal(out.rolledBack, true);
    const last = m.commands().at(-1) as string;
    assert.match(last, stop);
    assert.match(last, new RegExp(`${CLI.replace(/[.*+?^${}()|[\]\\$"]/g, '\\$&')} uninstall`));
    assert.match(last, new RegExp(`rm -f ".*current"; rm -rf ".*versions/${SHA}"`), 'a fresh install leaves no current and no version');
    assert.deepEqual(out.steps.map((s: any) => s.state).slice(-2), ['failed', 'ok']);
  }
});

test('a rollback puts current back where it pointed, and keeps a version that was already there', async () => {
  const prev = "/home/u/.mopilot-host/versions/o'ld";
  const m = machine({ 'systemctl --user enable': { code: 1, stderr: 'bus' }, 'tar -xzf': { stdout: `made=no prev=${prev}\n` } });
  const out = await createInstaller({ channel: m.channel, bundle }).install('me@box');
  assert.equal(out.rolledBack, true);
  const last = m.commands().at(-1) as string;
  assert.ok(last.includes(`ln -sfn '/home/u/.mopilot-host/versions/o'\\''ld' "$HOME/.mopilot-host/current"`), last);
  assert.ok(!last.includes('rm -rf'), 'a version this run did not unpack stays');
});

test('a failed rollback is shown and the install still counts as failed', async () => {
  const m = machine({ install: { code: 1, stderr: 'EACCES' }, uninstall: { code: 1, stderr: 'no bin' } });
  const out = await createInstaller({ channel: m.channel, bundle }).install('me@box');
  assert.deepEqual([out.ok, out.failedStep, out.rolledBack], [false, 'unit', false]);
  assert.equal(out.steps.at(-1).id, 'rollback');
  assert.equal(out.steps.at(-1).state, 'failed');
});

test('a failure before anything was written to the machine changes nothing there (no rollback)', async () => {
  for (const [script, step, why] of [
    [{ 'uname -sm': { stdout: 'FreeBSD amd64\n' } }, 'connect', /only Linux and macOS/],
    [{ 'uname -sm': { stdout: '' } }, 'connect', /Unknown system/],
    [{ 'uname -sm': { code: 255, stderr: 'Permission denied (publickey).' } }, 'connect', /Permission denied/],
    [{ 'uname -sm': { code: 255 } }, 'connect', /The command failed/],
    [{ 'echo have': { stdout: 'need\n' }, 'curl -fsSL': { code: 1, stderr: 'no curl' } }, 'node', /could get Node v24.*no curl/s],
    [{ 'echo have': { stdout: 'need\n' }, 'echo placed': { stdout: 'cannot-run\n' }, '-lic': { code: 1 } }, 'node', /glibc 2\.28/],
  ] as const) {
    const m = machine(script as any);
    const out = await createInstaller({ channel: m.channel, registry, bundle }).install('me@box');
    assert.equal(out.failedStep, step);
    assert.match(out.error, why);
    assert.ok(!m.commands().some((c) => c.includes('uninstall')), 'nothing to undo');
    assert.equal(out.rolledBack, false);
  }
});

test('an npm package needs Node 22+ on the machine: an older or missing one fails before anything is written', async () => {
  for (const [script, why] of [
    [{ 'node --version': { stdout: 'v18.0.0' } }, /Node 22 or newer.*v18.*nodejs\.org/],
    [{ 'node --version': { stdout: '' } }, /found none/],
    [{ 'node --version': { stdout: 'oops' } }, /Node 22/],
  ] as const) {
    const m = machine(script as any);
    const out = await createInstaller({ channel: m.channel, packageSpec: 'mopilot-host' }).install('me@box');
    assert.deepEqual([out.failedStep, out.rolledBack], ['node', false]);
    assert.match(out.error, why);
  }
});

test('the uploaded Host brings its own Node: one step, and a channel that throws while checking for it still ends in a working Node', async () => {
  const m = machine({ 'echo have': new Error('ssh gone') });
  const out = await createInstaller({ channel: m.channel, bundle }).install('me@box');
  assert.equal(out.ok, true);
  const node = out.steps.find((s: any) => s.id === 'node');
  assert.deepEqual([node.label, node.output], ['Set up Node', 'Node v24.22.2, downloaded on the machine']);
  assert.ok(!m.commands().includes('node --version'), "the machine's own node is not asked for");
  // the Host then runs on that Node
  assert.ok(m.commands().includes(`${CLI} install`) && CLI.includes('"$HOME/.mopilot-host/runtime/current/bin/node"'));
});

test('a Host package this app cannot supply is a failed step before any upload (B1)', async () => {
  const none = machine();
  const a = await createInstaller({ channel: none.channel }).install('me@box');
  assert.deepEqual([a.failedStep, a.error], ['prepare', 'This app has no Host package to upload.']);
  assert.ok(!none.commands().some((c) => c.includes('cat >')));
  const broke = machine();
  const b = await createInstaller({
    channel: broke.channel,
    bundle: () => {
      throw new Error('The package is not installed.');
    },
  }).install('me@box');
  assert.deepEqual([b.failedStep, b.error], ['prepare', 'The package is not installed.']);
  const wrong = machine();
  const c = await createInstaller({ channel: wrong.channel, bundle: () => ({ file: FILE, sha256: '0'.repeat(64), version: '1' }) }).install(
    'me@box',
  );
  assert.match(c.error, /does not match its checksum/);
  assert.ok(!wrong.commands().some((c) => c.includes('cat >')), 'a build that is not what its manifest says is never sent');
  const gone = await createInstaller({
    channel: wrong.channel,
    bundle: async () => ({ file: path.join(dir, 'missing.tgz'), sha256: SHA, version: '1' }),
  }).install('me@box');
  assert.equal(gone.failedStep, 'prepare');
});

test('an upload that fails or does not verify is tidied away and reported; nothing else on the machine is touched', async () => {
  const full = machine({ 'cat >': { code: 1, stderr: 'No space left on device' } });
  const a = await createInstaller({ channel: full.channel, bundle }).install('me@box');
  assert.deepEqual([a.failedStep, a.rolledBack], ['upload', false]);
  assert.match(a.error, /No space left/);
  assert.match(full.commands().at(-1) as string, new RegExp(`rm -f ".*incoming/${SHA}\\.tgz"`));
  for (const reply of [{ code: 1, stderr: 'got abc' }, { stdout: 'abc\n' }]) {
    const m = machine({ sha256sum: reply });
    const b = await createInstaller({ channel: m.channel, bundle }).install('me@box');
    assert.deepEqual([b.failedStep, b.rolledBack], ['verify', false]);
    assert.match(b.error, /got abc|does not match its checksum/);
    assert.ok(!m.commands().some((c) => c.includes('tar -xzf')), 'an upload that failed the check is never unpacked');
  }
  const bad = machine({ 'tar -xzf': { stdout: 'garbage' } });
  const c = await createInstaller({ channel: bad.channel, bundle }).install('me@box');
  assert.deepEqual([c.failedStep, c.rolledBack, c.error], ['unpack', false, 'The Host could not be unpacked.']);
  const tarFails = machine({ 'tar -xzf': { code: 1, stderr: 'tar: Unexpected EOF' } });
  assert.equal((await createInstaller({ channel: tarFails.channel, bundle }).install('me@box')).failedStep, 'unpack');
});

test('a reinstall that fails after it moved `current` puts the Host back on its version and starts it again', async () => {
  const again = machine({
    'test -f': { stdout: `installed\n${JSON.stringify(status)}` },
    'tar -xzf': { stdout: 'made=yes prev=/old\n' },
    pair: { code: 1, stderr: 'no' },
  });
  const out = await createInstaller({ channel: again.channel, bundle }).install('me@box');
  assert.deepEqual([out.ok, out.failedStep, out.rolledBack], [false, 'pair', true]);
  const back = again.commands().find((c) => c.includes('ln -sfn') && c.includes('systemctl --user restart') && c.includes('/old'));
  assert.ok(back, 'the old version is put back and started');
  assert.ok(back.indexOf('/old') < back.indexOf('systemctl --user restart'));
  assert.doesNotMatch(back, /uninstall|disable --now/, 'the Host that was there stays installed');
  assert.ok(!again.commands().some((c) => c.includes('uninstall')));
});

test('a reinstall with nothing to go back to leaves things as they are and says so', async () => {
  const noPrev = machine({
    'test -f': { stdout: `installed\n${JSON.stringify(status)}` },
    'tar -xzf': { stdout: 'made=yes prev=\n' },
    pair: { code: 1, stderr: 'no' },
  });
  const out = await createInstaller({ channel: noPrev.channel, bundle }).install('me@box');
  assert.deepEqual([out.failedStep, out.rolledBack], ['pair', false]);
  assert.ok(!out.steps.some((s: any) => s.id === 'rollback'));
});

test('a repeated install on a machine that already has the Host runs through again, adds the same record, and never uninstalls it when it fails', async () => {
  added.length = 0;
  const present = {
    'test -f': { stdout: `installed\n${JSON.stringify({ ...status, running: false })}` },
    'tar -xzf': { stdout: 'made=no prev=/x\n' },
  };
  const again = machine(present);
  const installer = createInstaller({ channel: again.channel, registry, bundle });
  assert.equal((await installer.install('me@box')).ok, true);
  assert.equal((await installer.install('me@box')).ok, true);
  assert.deepEqual(
    added.map((a) => a.id),
    ['ssh:me@box', 'ssh:me@box'],
  );
  assert.equal(again.commands().filter((c) => c.startsWith(`${CLI} install`)).length, 2);
  const failing = machine({ ...present, 'systemctl --user enable': { code: 1, stderr: 'bus' } });
  const out = await createInstaller({ channel: failing.channel, bundle }).install('me@box');
  assert.deepEqual([out.ok, out.failedStep, out.rolledBack], [false, 'start', false]);
  assert.ok(!failing.commands().some((c) => c.includes('uninstall')), 'the Host that was there stays');
});

test("a Host whose files are there but which cannot run yet (installed on the machine's node, now off the ssh PATH) still counts as there: a failure never uninstalls it", async () => {
  const old = machine({
    'test -f': { stdout: 'installed\nzsh:1: command not found: node\n' },
    'tar -xzf': { stdout: 'made=no prev=/x\n' },
    'systemctl --user enable': { code: 1, stderr: 'bus' },
  });
  const out = await createInstaller({ channel: old.channel, bundle }).install('me@box');
  assert.deepEqual([out.failedStep, out.rolledBack], ['start', false]);
  assert.equal(out.steps[1].output, 'A Host is already installed; it stays if this fails.');
  assert.ok(!old.commands().some((c) => c.includes('uninstall')), 'the Host that was there stays');
});

test('an npm package named instead runs the old way: installed on the machine, the Host from its PATH', async () => {
  const m = machine();
  const out = await createInstaller({ channel: m.channel, packageSpec: "a'b" }).install('mac');
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.steps.map((s: any) => s.id),
    ['connect', 'detect', 'node', 'package', 'unit', 'start', 'linger', 'status', 'pair'],
  );
  assert.equal(upto(m, 'npm install'), "npm install -g 'a'\\''b'");
  assert.ok(m.commands().includes('mopilot-host install'));
  assert.ok(!m.commands().some((c) => c.includes('cat >')));
  const failing = machine({ 'npm install': { code: 1, stderr: 'E404' } });
  const f = await createInstaller({ channel: failing.channel, packageSpec: 'x' }).install('me@box');
  assert.deepEqual([f.failedStep, f.rolledBack], ['package', false]);
  const unit = machine({ install: { code: 1, stderr: 'EACCES' } });
  const u = await createInstaller({ channel: unit.channel, packageSpec: 'x' }).install('me@box');
  assert.equal(u.rolledBack, true);
  assert.ok(unit.commands().at(-1)?.endsWith('; mopilot-host uninstall'));
});

test('the status check waits for a Host that is starting, and gives up with the reason (B2)', async (t) => {
  const clock = useFakeClock(t);
  let calls = 0;
  const m = machine({
    status: () => (++calls < 3 ? { stdout: JSON.stringify({ ...status, running: false }) } : { stdout: JSON.stringify(status) }),
  });
  const p = createInstaller({ channel: m.channel, bundle }).install('me@box');
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setImmediate(r));
    clock.advance(1000);
  }
  const out = await p;
  assert.equal(out.ok, true);
  assert.equal(out.steps.filter((s: any) => s.id === 'status').length, 1, 'one line for the check, not one per try');
  const run = async (reply: object) => {
    const never = machine({ status: reply as any });
    const q = createInstaller({ channel: never.channel, bundle }).install('me@box');
    for (let i = 0; i < 12; i++) {
      await new Promise((x) => setImmediate(x));
      clock.advance(1000);
    }
    return q;
  };
  const bad = await run({ stdout: 'not json' });
  assert.deepEqual([bad.ok, bad.failedStep, bad.rolledBack], [false, 'status', true]);
  assert.match(bad.error, /cannot read/);
  assert.match((await run({ stdout: JSON.stringify({ ...status, socketPath: undefined }) })).error, /did not say where it listens/);
  // a path that would turn `ssh -L` into a socket-to-TCP forward is no path the Host listens on
  assert.match(
    (await run({ stdout: JSON.stringify({ ...status, socketPath: '/h/host.sock:10.0.0.5:6379' }) })).error,
    /did not say where it listens/,
  );
  assert.match((await run({ stdout: JSON.stringify({ running: true }) })).error, /not running yet/);
  // a Host that won't serve without its core says why, in the words the machine gave
  const noCore = { ...status, running: false, core: { loaded: false, problem: 'The Rust core is missing.' } };
  assert.equal((await run({ stdout: JSON.stringify(noCore) })).error, 'The Rust core is missing.');
});

test('a channel that throws is a failed step, not a rejected install (B2)', async () => {
  const m = machine({ 'uname -sm': new Error('spawn ssh ENOENT') });
  const out = await createInstaller({ channel: m.channel, bundle }).install('me@box');
  assert.deepEqual([out.ok, out.error], [false, 'spawn ssh ENOENT']);
  // and the tidy-up after a failed upload that throws is reported, never raised
  const tidy = machine({ 'cat >': { code: 1, stderr: 'full' }, 'rm -f': new Error('ssh gone') });
  assert.equal((await createInstaller({ channel: tidy.channel, bundle }).install('me@box')).failedStep, 'upload');
});

test('a second request for a machine already being installed joins the run in flight and sees its steps (A1)', async () => {
  let release: (v: any) => void = () => {};
  const m = machine({ 'echo have': new Promise((r) => (release = r)) });
  const installer = createInstaller({ channel: m.channel, bundle });
  const late: string[] = [];
  const first = installer.install('me@box');
  await new Promise((r) => setImmediate(r));
  const second = installer.install('me@box', (s: any) => late.push(`${s.id}:${s.state}`));
  assert.ok(late.includes('connect:ok'), 'steps so far are replayed');
  release({ stdout: 'have\n' });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.ok(late.includes('pair:ok'));
  assert.equal(m.commands().filter((c) => c === 'uname -sm').length, 1);
  // once it ended, a new request runs afresh
  assert.equal((await installer.install('me@box')).steps.length, 12);
});

test('an address that is not a machine is refused before any ssh runs (B1)', async () => {
  const m = machine();
  const installer = createInstaller({ channel: m.channel, bundle });
  for (const bad of ['', '-oProxyCommand=x', 'a b', 'a;rm', null, 7, 'x'.repeat(300)]) {
    const out = await installer.install(bad as any);
    assert.deepEqual([out.ok, out.error], [false, 'Enter a machine as user@host.']);
  }
  assert.equal(m.ran.length, 0);
  assert.equal(validDestination('me@build.example'), true);
  assert.equal(validDestination('[::1]'), false);
});

class Child extends EventEmitter {
  stdin: any = Object.assign(new EventEmitter(), {
    sent: undefined as unknown,
    end(b: unknown) {
      this.sent = b;
    },
  });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(s: string) {
    this.killed.push(s);
  }
}
test('the real channel runs ssh without prompts, keeps its output, and turns every failure into a result (B2)', async (t) => {
  const clock = useFakeClock(t);
  const children: Child[] = [];
  const calls: any[] = [];
  let boom = false;
  useFakeProc(t, {
    spawn: (bin: string, args: string[], opts: any) => {
      calls.push({ bin, args, opts });
      if (boom) throw new Error('EMFILE');
      const c = new Child();
      children.push(c);
      return c;
    },
  });
  const ssh = createSshChannel({ sshArgs: ['-p', '2222'], env: () => ({ PATH: '/x' }), timeoutMs: 1000 });
  const p = ssh('me@box', 'uname -sm');
  // L3: no agent, display or forward of this Mac reaches the machine, whatever the user's ssh config says; those options come first so the user's own cannot undo them
  assert.deepEqual(calls[0].args, [
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-p',
    '2222',
    '--',
    'me@box',
    'uname -sm',
  ]);
  assert.deepEqual(calls[0].opts.env, { PATH: '/x' });
  children[0].stdout.emit('data', Buffer.from('Linux x86_64\n'));
  children[0].stderr.emit('data', Buffer.from('warning'));
  children[0].emit('close', 0);
  children[0].emit('close', 1);
  assert.deepEqual(await p, { code: 0, stdout: 'Linux x86_64\n', stderr: 'warning' });
  // a long output keeps its tail
  const big = ssh('me@box', 'x');
  children[1].stdout.emit('data', Buffer.alloc(70 * 1024, 'a'));
  children[1].emit('close', null);
  const r = await big;
  assert.equal(r.stdout.length, 64 * 1024);
  assert.equal(r.code, -1);
  // ssh missing: the error event
  const missing = ssh('me@box', 'x');
  children[2].stderr.emit('data', Buffer.from('partial'));
  children[2].emit('error', new Error('ENOENT'));
  assert.deepEqual(await missing, { code: -1, stdout: '', stderr: 'partial\nENOENT' });
  // a hang: killed and reported
  const hung = ssh('me@box', 'x');
  clock.advance(1000);
  assert.deepEqual(children[3].killed, ['SIGTERM']);
  assert.deepEqual(await hung, { code: -1, stdout: '', stderr: 'Timed out.' });
  // spawn itself throwing
  boom = true;
  assert.deepEqual(await ssh('me@box', 'x'), { code: -1, stdout: '', stderr: 'EMFILE' });
  // bytes for the command's input go to its standard input, and a pipe that closes early is no crash
  boom = false;
  const up = ssh('me@box', 'cat > f', Buffer.from('bytes'));
  assert.equal(calls.at(-1).opts.stdio[0], 'pipe');
  assert.equal(children.at(-1)?.stdin.sent.toString(), 'bytes');
  children.at(-1)?.stdin.emit('error', new Error('EPIPE'));
  children.at(-1)?.emit('close', 1);
  assert.equal((await up).code, 1);
  assert.equal(calls[0].opts.stdio[0], 'ignore', 'a command with no input reads none');
  // defaults
  const plain = createSshChannel();
  const q = plain('h', 'c');
  children.at(-1)?.emit('close', 0);
  await q;
  assert.equal(calls.at(-1).bin, 'ssh');
});

test('M1: with the app’s key the install makes the machine trust it for updates, after the unit and before the Host starts; a machine that will not is rolled back', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const app = generateKeyPairSync('ed25519');
  const der = app.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  added.length = 0;
  const m = machine();
  const out = await createInstaller({ channel: m.channel, registry, bundle, updateKey: () => der }).install('me@build.example');
  assert.equal(out.ok, true);
  assert.deepEqual(out.steps.map((s: any) => s.id).slice(-6), ['unit', 'trust', 'start', 'linger', 'status', 'pair']);
  const trust = m.ran.find((r) => r.command.includes('trust-update-key'))!;
  assert.equal(trust.command, `${CLI} trust-update-key`);
  assert.equal(
    String(trust.input),
    app.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    'the app’s public key, as PEM, on standard input',
  );
  assert.equal(out.steps.find((s: any) => s.id === 'trust').output, 'Updates are taken from this app only.');
  // a machine that cannot keep it fails the install, and the unit is taken off again
  const refusing = machine({ 'trust-update-key': { code: 1, stderr: 'disk full' } });
  const failed = await createInstaller({ channel: refusing.channel, registry, bundle, updateKey: () => der }).install('me@build.example');
  assert.deepEqual([failed.ok, failed.failedStep, failed.rolledBack], [false, 'trust', true]);
  assert.ok(refusing.commands().some((c) => c.includes('uninstall')));
  assert.ok(!refusing.commands().some((c) => c.includes('systemctl --user enable')), 'the Host was not started');
});
