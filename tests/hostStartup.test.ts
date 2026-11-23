// Whether a Host starts at boot (host/src/startup.mjs) and what install, uninstall and serve do when a Mac runs it as a system daemon (host/src/install.mjs, host/src/cli.mjs): a Mac says yes when launchd runs it as the daemon and whether FileVault is on, Linux says whether the user lingers, a Host from a terminal says nothing; under the daemon no agent is written or left behind and uninstall refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createStartupCheck, output } from '../host/src/startup.mjs';
// @ts-ignore: plain ESM without declarations
import { daemonInfo, dropAgentUnderDaemon, installUnit, runsAsDaemon } from '../host/src/install.mjs';
// @ts-ignore: plain ESM without declarations
import { main } from '../host/src/cli.mjs';
import { hostStatus } from '../host/src/status.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-startup-'));
const asked: string[][] = [];
const answering =
  (answers: Record<string, string | null>) =>
  async (bin: string, args: string[]): Promise<string | null> => {
    asked.push([bin, ...args]);
    return answers[bin] ?? null;
  };

test('a Mac: the system daemon starts at boot, the agent does not; FileVault as fdesetup says it, unknown when it cannot', async () => {
  const run = answering({ '/usr/bin/fdesetup': 'FileVault is On.\n' });
  assert.deepEqual(await createStartupCheck({ platform: 'darwin', env: { MOPILOT_HOST_SUPERVISED: 'system' }, run })(), {
    atBoot: 'yes',
    fileVault: 'on',
  });
  assert.deepEqual(
    await createStartupCheck({
      platform: 'darwin',
      env: { MOPILOT_HOST_SUPERVISED: '1' },
      run: answering({ '/usr/bin/fdesetup': 'FileVault is Off.\n' }),
    })(),
    { atBoot: 'no', fileVault: 'off' },
  );
  assert.deepEqual(await createStartupCheck({ platform: 'darwin', env: { MOPILOT_HOST_SUPERVISED: '1' }, run: answering({}) })(), {
    atBoot: 'no',
    fileVault: 'unknown',
  });
});

test('Linux: lingering is starting at boot; any other answer is unknown, and FileVault is not a thing there', async () => {
  for (const [said, atBoot] of [
    ['yes\n', 'yes'],
    ['no\n', 'no'],
    ['maybe', 'unknown'],
    [null, 'unknown'],
  ] as const) {
    asked.length = 0;
    const check = createStartupCheck({
      platform: 'linux',
      env: { MOPILOT_HOST_SUPERVISED: '1' },
      user: 'u',
      run: answering({ loginctl: said }),
    });
    assert.deepEqual(await check(), { atBoot, fileVault: 'unknown' });
    assert.deepEqual(asked, [['loginctl', 'show-user', 'u', '--property=Linger', '--value']]);
  }
});

test('a Host from a terminal, or on another system, does not say', async () => {
  asked.length = 0;
  assert.deepEqual(await createStartupCheck({ platform: 'darwin', env: {}, run: answering({}) })(), {
    atBoot: 'unknown',
    fileVault: 'unknown',
  });
  assert.deepEqual(await createStartupCheck({ platform: 'win32', env: { MOPILOT_HOST_SUPERVISED: '1' }, run: answering({}) })(), {
    atBoot: 'unknown',
    fileVault: 'unknown',
  });
  assert.deepEqual(asked, []);
});

test('the answer is kept for a minute: calls meanwhile share it, a later one asks again', async () => {
  let t = 0;
  let n = 0;
  const check = createStartupCheck({
    platform: 'linux',
    env: { MOPILOT_HOST_SUPERVISED: '1' },
    user: 'u',
    now: () => t,
    run: async () => (++n === 1 ? 'no' : 'yes'),
  });
  assert.equal((await check()).atBoot, 'no');
  t = 59_999;
  assert.equal((await check()).atBoot, 'no');
  t = 60_000;
  assert.equal((await check()).atBoot, 'yes');
  assert.equal(n, 2);
  // the defaults: this process's platform, environment and user
  assert.equal(typeof createStartupCheck(), 'function');
});

test('one probe command: its output, or null when it fails or cannot start', async () => {
  assert.equal(await output(process.execPath, ['-e', 'process.stdout.write("hi")']), 'hi');
  assert.equal(await output(process.execPath, ['-e', 'process.exit(3)']), null);
  assert.equal(await output('/nonexistent/bin', []), null);
});

test('the status carries the startup answer, unknown by default', () => {
  assert.deepEqual(hostStatus({ running: true }).startup, { atBoot: 'unknown', fileVault: 'unknown' });
  assert.deepEqual(hostStatus({ running: true, startup: { atBoot: 'yes', fileVault: 'on' } }).startup, { atBoot: 'yes', fileVault: 'on' });
});

test('under the daemon, install writes no agent (and removes one) and starting restarts the daemon’s Host', () => {
  const home = tmp();
  const daemonPlist = path.join(home, 'daemon.plist');
  const unit = { home, env: {}, nodePath: '/n', binPath: '/b', dataDir: '/d', platform: 'darwin' as const, daemonPlist };
  // no daemon: the agent as before
  assert.equal(runsAsDaemon(unit), false);
  const agent = installUnit(unit);
  assert.equal(agent.daemon, false);
  assert.ok(fs.existsSync(agent.file));
  fs.writeFileSync(daemonPlist, '<plist/>');
  assert.equal(runsAsDaemon(unit), true);
  // Linux never runs it as a launchd daemon
  assert.equal(runsAsDaemon({ ...unit, platform: 'linux' }), false);
  const daemon = installUnit(unit);
  assert.deepEqual({ file: daemon.file, daemon: daemon.daemon }, { file: daemonPlist, daemon: true });
  assert.ok(!fs.existsSync(agent.file), 'the agent would start a second Host at the next sign-in');
  assert.match(daemon.start, /pkill -TERM/);
  // the default place is /Library/LaunchDaemons
  const real = installUnit({ ...unit, daemonPlist: undefined });
  assert.equal(real.daemon, fs.existsSync('/Library/LaunchDaemons/ai.mopilot.host.plist') && process.platform === 'darwin');
});

test('a Host the daemon started removes the agent left from before; any other Host leaves it', () => {
  const home = tmp();
  const agent = path.join(home, 'Library', 'LaunchAgents', 'ai.mopilot.host.plist');
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.writeFileSync(agent, 'x');
  assert.equal(dropAgentUnderDaemon({ platform: 'darwin', home, env: { MOPILOT_HOST_SUPERVISED: '1' } }), false);
  assert.equal(dropAgentUnderDaemon({ platform: 'linux', home, env: { MOPILOT_HOST_SUPERVISED: 'system' } }), false);
  assert.ok(fs.existsSync(agent));
  assert.equal(dropAgentUnderDaemon({ platform: 'darwin', home, env: { MOPILOT_HOST_SUPERVISED: 'system' } }), true);
  assert.ok(!fs.existsSync(agent));
  assert.equal(dropAgentUnderDaemon({ platform: 'darwin', home, env: { MOPILOT_HOST_SUPERVISED: 'system' } }), false);
  // the defaults are this process's own (not the daemon here)
  assert.equal(dropAgentUnderDaemon({}), process.env.MOPILOT_HOST_SUPERVISED === 'system' && process.platform === 'darwin');
});

test('what the daemon needs: the links an install keeps current when this Host runs from them, else its own paths', () => {
  const home = tmp();
  const links: Record<string, string> = {
    [path.join(home, '.mopilot-host/runtime/current/bin/node')]: '/real/node',
    [path.join(home, '.mopilot-host/current/host/bin/mopilot-host.mjs')]: '/real/bin',
  };
  const realpath = (p: string) => {
    if (p in links) return links[p];
    if (p.startsWith('/real/')) return p;
    throw new Error('ENOENT');
  };
  const base = { home, env: { PATH: '/usr/bin' }, user: 'jane', dataDir: '/d', realpath };
  assert.deepEqual(daemonInfo({ ...base, nodePath: '/real/node', binPath: '/real/bin' }), {
    user: 'jane',
    home,
    node: path.join(home, '.mopilot-host/runtime/current/bin/node'),
    bin: path.join(home, '.mopilot-host/current/host/bin/mopilot-host.mjs'),
    dataDir: '/d',
    path: '/usr/bin',
  });
  // a Host run from elsewhere (an npm install, the machine's own Node) names itself
  const other = daemonInfo({ ...base, nodePath: '/real/other-node', binPath: '/elsewhere/bin' });
  assert.equal(other.node, '/real/other-node');
  assert.equal(other.bin, '/elsewhere/bin');
  assert.throws(() => daemonInfo({ ...base, env: { PATH: 'a\nb' }, nodePath: '/n', binPath: '/b' }), /control character/);
  // the defaults: this user, home, environment and the file system's own realpath
  const own = daemonInfo({ nodePath: process.execPath, binPath: '/nope', dataDir: '/d' });
  assert.equal(own.user, os.userInfo().username);
  assert.equal(own.bin, '/nope');
  assert.equal(daemonInfo({ nodePath: '/n', binPath: '/b', dataDir: '/d', env: {} }).path, '');
});

const io = (extra = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const stopped: unknown[] = [];
  return {
    out,
    err,
    stopped,
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), stopService: (c: unknown) => stopped.push(c), ...extra },
  };
};

test('the CLI: install --print-daemon says what the daemon needs; under the daemon install restarts it and uninstall refuses', async () => {
  const home = tmp();
  const dir = tmp();
  const daemonPlist = path.join(home, 'daemon.plist');
  let r = io({ home, platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, daemonPlist });
  assert.equal(await main(['install', '--print-daemon', '--data-dir', dir], r.io), 0);
  const said = JSON.parse(r.out[0]);
  assert.equal(said.home, home);
  assert.equal(said.dataDir, dir);
  assert.equal(said.user, os.userInfo().username);
  // nothing was written by asking
  assert.ok(!fs.existsSync(path.join(home, 'Library/LaunchAgents/ai.mopilot.host.plist')));
  fs.writeFileSync(daemonPlist, '<plist/>');
  r = io({ home, platform: 'darwin', env: {}, daemonPlist });
  assert.equal(await main(['install', '--data-dir', dir], r.io), 0);
  assert.match(r.out[0], new RegExp(`^Starts at boot from ${daemonPlist}\\nRestart it with: if \\[ -f `));
  r = io({ home, platform: 'darwin', env: {}, daemonPlist });
  assert.equal(await main(['uninstall', '--data-dir', dir], r.io), 1);
  assert.match(r.err[0], /Turn off “Keep running after restart” in MoPilot first/);
  assert.deepEqual(r.stopped, [], 'nothing is stopped by a refused uninstall');
});

test('startup and Rust core states coexist in one Host status snapshot', () => {
  const startup = { atBoot: 'yes', fileVault: 'on' } as const;
  for (const rustCore of [
    { loaded: true, build: 'darwin-arm64', routes: 2, problem: null },
    { loaded: false, build: null, routes: 0, problem: 'no build for this machine' },
  ]) {
    const status = hostStatus({ running: true, platform: 'darwin', startup, rustCore });
    assert.deepEqual(status.startup, startup);
    assert.deepEqual(status.core, rustCore);
  }
});
