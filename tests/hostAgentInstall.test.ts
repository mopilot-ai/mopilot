// Installing a missing agent on the Host (host/src/agentInstall.mjs): only the npm line of the app's install table runs, into the Host's own prefix, one install at a time; the new CLI must start; failures carry the exact reason with secrets cut out (A: join, queue, cancel, close; W: already installed, no npm, timeouts; B: recipes, PATH, output shapes; I: npm's failures).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonLineLog } from '../scripts/fixture-json-log.mjs';
// @ts-ignore: plain ESM without declarations
import { createInstaller, hostPath, installRecipe, npmReason, scrub, toolsDir } from '../host/src/agentInstall.mjs';

const FAKE_NPM = path.join(import.meta.dirname, 'fixtures/fake-npm.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-install-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * A Host whose Node folder holds `node` and (unless `npm: false`) the fake npm, as an installed Node does; `mode` is the fake's behavior.
 * The log lists each npm run's start and end.
 */
function world(
  mode: string,
  o: { npm?: boolean; bin?: string; installMs?: number; versionMs?: number; killMs?: number; pathDirs?: string[]; spawnFn?: any } = {},
) {
  const root = fs.mkdtempSync(path.join(base, 'w-'));
  const nodeDir = path.join(root, 'node', 'bin');
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
  if (o.npm !== false) fs.copyFileSync(FAKE_NPM, path.join(nodeDir, 'npm')), fs.chmodSync(path.join(nodeDir, 'npm'), 0o755);
  const dataDir = path.join(root, 'data');
  const log = path.join(root, 'npm.log');
  const env: Record<string, string> = {
    PATH: hostPath([...(o.pathDirs ?? []), '/usr/bin', '/bin'].join(path.delimiter), dataDir, path.join(nodeDir, 'node')),
    FAKE_NPM_MODE: mode,
    FAKE_NPM_LOG: log,
    FAKE_NPM_BIN: o.bin ?? 'codex',
  };
  const installer = createInstaller({
    dataDir,
    env,
    platform: 'darwin',
    execPath: path.join(nodeDir, 'node'),
    installMs: o.installMs,
    versionMs: o.versionMs,
    killMs: o.killMs,
    ...(o.spawnFn ? { spawnFn: o.spawnFn } : {}),
  });
  const runs = () => readJsonLineLog(log);
  return { root, dataDir, env, installer, runs, prefix: toolsDir(dataDir) };
}

test('B: a recipe is the npm line of the install table for Claude Code, Codex and an ACP agent; anything else has none', () => {
  assert.deepEqual(installRecipe('codex', 'darwin'), { harness: 'codex', name: 'Codex', spec: '@openai/codex', bins: ['codex'] });
  assert.deepEqual(installRecipe('claude', 'linux'), {
    harness: 'claude',
    name: 'Claude Code',
    spec: '@anthropic-ai/claude-code',
    bins: ['claude'],
  });
  assert.deepEqual(installRecipe('gemini', 'linux'), { harness: 'gemini', name: 'Gemini', spec: '@google/gemini-cli', bins: ['gemini'] });
  assert.equal(installRecipe('qwen', 'darwin')?.spec, '@qwen-code/qwen-code@latest', 'a dist-tag in the table is kept');
  // a vendor with only a script or an app, Windows, an id the table does not know, a name off the prototype, and the default platform
  for (const [id, platform] of [
    ['cursor', 'darwin'],
    ['codex', 'win32'],
    ['nope', 'linux'],
    ['__proto__', 'linux'],
    ['toString', 'darwin'],
    [3, 'linux'],
  ] as const)
    assert.equal(installRecipe(id as any, platform), null, `${String(id)} on ${platform}`);
  assert.equal(installRecipe('codex')?.spec, process.platform === 'win32' ? undefined : '@openai/codex');
});

test('B: the Host PATH keeps its own folders first and adds its tools folder and its Node folder once', () => {
  const p = hostPath('/opt/homebrew/bin:/usr/bin', '/data', '/n/bin/node');
  assert.equal(p, '/opt/homebrew/bin:/usr/bin:/data/tools/bin:/n/bin');
  assert.equal(hostPath(p, '/data', '/n/bin/node'), p, 'a second pass adds nothing');
  assert.equal(hostPath(undefined, '/data', '/n/bin/node'), '/data/tools/bin:/n/bin');
  assert.ok(hostPath('', '/data').endsWith(path.dirname(process.execPath)));
});

test('B: scrub cuts tokens, auth headers and passwords in addresses out of a line', () => {
  assert.equal(scrub('//registry.example/:_authToken=abc123 x'), '//registry.example/:_authToken=*** x');
  assert.equal(scrub('Authorization: Bearer sk-123'), 'Authorization: Bearer ***');
  assert.equal(scrub('fetch https://me:pa55@proxy.example:8080/x'), 'fetch https://***@proxy.example:8080/x');
  assert.equal(scrub('password: hunter2'), 'password: ***');
  assert.equal(scrub('added 1 package'), 'added 1 package');
});

test("I: npm's failure reads as what it means, else as its own error lines, else its exit code", () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT'])
    assert.equal(npmReason([`npm error code ${code}`], 1), "Couldn't reach the npm registry. Check this machine's network or proxy.");
  assert.equal(npmReason(['npm ERR! code E404'], 1), 'npm could not find the package.');
  assert.equal(npmReason(['npm error code EACCES'], 243), 'npm was not allowed to write its files.');
  assert.match(npmReason(['npm error code SELF_SIGNED_CERT_IN_CHAIN'], 1), /did not trust the registry's certificate/);
  assert.equal(
    npmReason(
      [
        'npm error code EBADENGINE',
        'npm error engine Unsupported engine',
        'npm error',
        'npm error A complete log of this run can be found in: x',
      ],
      1,
    ),
    'engine Unsupported engine',
  );
  assert.equal(npmReason(['something else'], 7), 'npm ended with code 7.');
});

test('the install runs npm into the Host prefix, checks the new CLI starts, and ends done with its version', async () => {
  const w = world('ok');
  const started = w.installer.start({ harness: 'codex' });
  assert.equal(started.state, 'queued');
  assert.equal(w.installer.idle(), false);
  await until(() => w.installer.status('codex')?.state === 'done');
  const done = w.installer.status('codex')!;
  assert.deepEqual([done.version, done.error, done.line], ['1.2.3 (fake)', null, '']);
  const [start] = w.runs();
  assert.deepEqual(start.args, [
    'install',
    '--global',
    '--prefix',
    w.prefix,
    '--no-audit',
    '--no-fund',
    '--no-update-notifier',
    '@openai/codex',
  ]);
  assert.ok(fs.statSync(path.join(w.prefix, 'bin', 'codex')).mode & 0o100);
  assert.equal(fs.statSync(w.prefix).mode & 0o777, 0o700, 'the prefix is the Host user’s only');
  await until(() => w.installer.idle());
  // the next start finds it on the Host PATH and runs nothing
  const again = w.installer.start({ harness: 'codex' });
  assert.deepEqual([again.state, w.runs().length], ['done', 2]);
});

test('A: a second start joins the install under way; another agent waits for it, so npm never runs twice at once', async () => {
  const w = world('slow', { bin: 'gemini' });
  const a = w.installer.start({ harness: 'gemini' });
  const b = w.installer.start({ harness: 'gemini' });
  assert.equal(a, b, 'two clicks, or two windows, read the one install');
  const c = w.installer.start({ harness: 'qwen' });
  await until(() => a.state === 'running');
  assert.equal(c.state, 'queued');
  assert.equal(c.line, 'Waiting for another install to finish…');
  await until(() => a.state === 'done');
  // qwen's fake puts `gemini` where qwen is looked for: its install fails on the missing binary, after gemini's run ended
  await until(() => c.state === 'failed');
  assert.match(String(c.error), /has no qwen command to run/);
  const runs = w.runs();
  assert.deepEqual(
    runs.map((r) => [r.what, r.args.at(-1)]),
    [
      ['start', '@google/gemini-cli'],
      ['end', '@google/gemini-cli'],
      ['start', '@qwen-code/qwen-code@latest'],
      ['end', '@qwen-code/qwen-code@latest'],
    ],
  );
});

test('W: an agent already on the Host PATH is done at once and nothing runs', () => {
  const own = fs.mkdtempSync(path.join(base, 'own-'));
  fs.writeFileSync(path.join(own, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const w = world('ok', { pathDirs: [own] });
  const done = w.installer.start({ harness: 'claude' });
  assert.deepEqual([done.state, w.installer.idle(), w.installer.status('claude')], ['done', true, done]);
  assert.deepEqual(w.runs(), []);
});

test("W: no npm beside the Host's Node or on its PATH fails with what to install", async () => {
  const w = world('ok', { npm: false });
  w.installer.start({ harness: 'codex' });
  await until(() => w.installer.status('codex')?.state === 'failed');
  assert.match(String(w.installer.status('codex')!.error), /npm isn't on this machine's PATH/);
});

test('I: a network failure reads as one, and a token or password npm printed never reaches the error', async () => {
  const net = world('netfail');
  net.installer.start({ harness: 'codex' });
  await until(() => net.installer.status('codex')?.state === 'failed');
  assert.equal(net.installer.status('codex')!.error, "Couldn't reach the npm registry. Check this machine's network or proxy.");
  const generic = world('generic');
  generic.installer.start({ harness: 'codex' });
  await until(() => generic.installer.status('codex')?.state === 'failed');
  assert.equal(generic.installer.status('codex')!.error, 'engine Unsupported engine //registry.example/:_authToken=***');
  const silent = world('silent-fail');
  silent.installer.start({ harness: 'codex' });
  await until(() => silent.installer.status('codex')?.state === 'failed');
  assert.equal(silent.installer.status('codex')!.error, 'npm ended with code 3.');
});

test('I: npm that exits 0 without the binary, or a binary that does not start, is not an install', async () => {
  const nobin = world('nobin');
  nobin.installer.start({ harness: 'codex' });
  await until(() => nobin.installer.status('codex')?.state === 'failed');
  assert.match(String(nobin.installer.status('codex')!.error), /^npm finished, but Codex has no codex command to run\.$/);
  const bad = world('badbin');
  bad.installer.start({ harness: 'codex' });
  await until(() => bad.installer.status('codex')?.state === 'failed');
  assert.equal(
    bad.installer.status('codex')!.error,
    'Codex was installed but does not start: Error: Cannot find module @openai/codex-darwin-arm64',
  );
  const hang = world('hangbin', { versionMs: 200 });
  hang.installer.start({ harness: 'codex' });
  await until(() => hang.installer.status('codex')?.state === 'failed');
  assert.equal(hang.installer.status('codex')!.error, 'Codex was installed but does not start: it did not answer in time.');
});

test('A: cancel stops the install under way and drops the one waiting; nothing to cancel says false', async () => {
  const w = world('hang', { bin: 'gemini' });
  assert.equal(w.installer.cancel('gemini'), false);
  w.installer.start({ harness: 'gemini' });
  w.installer.start({ harness: 'codex' });
  await until(() => w.runs().length === 1);
  assert.equal(w.installer.cancel('codex'), true);
  assert.equal(w.installer.cancel('gemini'), true);
  await until(() => w.installer.idle());
  assert.deepEqual(
    [w.installer.status('gemini')!.state, w.installer.status('codex')!.state, w.installer.status('codex')!.error],
    ['cancelled', 'cancelled', null],
  );
  assert.deepEqual(
    w.runs().map((r) => [r.what, r.args.at(-1)]),
    [['start', '@google/gemini-cli']],
    'the waiting install never ran',
  );
});

test('A: cancel while the new CLI is being checked ends cancelled, not failed', async () => {
  const w = world('hangbin');
  w.installer.start({ harness: 'codex' });
  await until(() => w.installer.status('codex')?.line === 'Checking Codex…');
  w.installer.cancel('codex');
  await until(() => w.installer.status('codex')?.state === 'cancelled');
});

test('A: closing the Host stops every install and starts none; I: an agent it cannot install is refused', async () => {
  const w = world('hang');
  w.installer.start({ harness: 'codex' });
  await until(() => w.installer.status('codex')?.state === 'running');
  w.installer.close();
  await until(() => w.installer.status('codex')?.state === 'cancelled');
  assert.throws(() => w.installer.start({ harness: 'gemini' }), /The Host is stopping/);
  assert.throws(
    () => w.installer.start({ harness: 'cursor' }),
    (e: any) => e.code === 'unsupported' && e.message === 'This Host cannot install that agent.',
  );
  assert.equal(w.installer.status('cursor'), null);
});

test('I: npm that cannot be started fails with the reason; a process that cannot be signalled as a group is killed alone', async () => {
  const failing = world('ok', {
    spawnFn: () => {
      const child: any = new EventEmitter();
      child.stdout = null;
      child.stderr = null;
      child.kill = () => true;
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
      return child;
    },
  });
  failing.installer.start({ harness: 'codex' });
  await until(() => failing.installer.status('codex')?.state === 'failed');
  assert.equal(failing.installer.status('codex')!.error, 'spawn EACCES');
  // a child with no pid (it never started) is killed by itself when cancelled
  let killed = 0;
  const nopid = world('ok', {
    spawnFn: (bin: string, args: string[], opts: any) => {
      const child: any = spawn(bin, args, opts);
      Object.defineProperty(child, 'pid', { value: undefined });
      const kill = child.kill.bind(child);
      child.kill = () => (killed++, kill('SIGKILL'));
      return child;
    },
    bin: 'codex',
  });
  nopid.env.FAKE_NPM_MODE = 'hang';
  nopid.installer.start({ harness: 'codex' });
  await until(() => nopid.installer.status('codex')?.state === 'running');
  await until(() => nopid.runs().length === 1);
  nopid.installer.cancel('codex');
  await until(() => nopid.installer.status('codex')?.state === 'cancelled');
  assert.equal(killed, 1);
});

test('installable lists the missing agents with a recipe', () => {
  const w = world('ok');
  assert.deepEqual(
    w.installer.installable([
      { id: 'claude', detected: true },
      { id: 'codex', detected: false },
      { id: 'cursor', detected: false },
      { id: 'gemini', detected: false },
    ]),
    ['codex', 'gemini'],
  );
});

test('A: a cancelled npm that keeps running is killed, and the next install waits until it is gone (two npm runs never share the prefix)', async () => {
  const lifecycle: string[] = [];
  let sequence = 0;
  let stoppedBy: string | null = null;
  const w = world('stubborn', {
    killMs: 300,
    spawnFn: (bin: string, args: string[], options: any) => {
      const child = spawn(bin, args, options);
      if (args[0] === 'install') {
        const index = sequence++;
        lifecycle.push(`start ${index}`);
        child.once('close', (_code, signal) => {
          lifecycle.push(`close ${index}`);
          if (index === 0) stoppedBy = signal;
        });
      }
      return child;
    },
  });
  w.env.FAKE_NPM_ONLY = 'gemini';
  w.installer.start({ harness: 'gemini' });
  const next = w.installer.start({ harness: 'codex' });
  await until(() => w.runs().length === 1);
  w.installer.cancel('gemini');
  await until(() => w.installer.status('gemini')!.state === 'cancelled');
  // the waiting install runs only after the stubborn one was killed
  await until(() => next.state === 'done');
  assert.deepEqual(lifecycle, ['start 0', 'close 0', 'start 1', 'close 1']);
  assert.equal(stoppedBy, 'SIGKILL');
  const started = w.runs().filter((r) => r.what === 'start');
  assert.equal(started.length, 2);
  assert.equal(w.runs().filter((r) => r.what === 'end').length, 1, 'the stubborn npm never reached its end');
});

test('I: a binary that does not start is taken off the PATH, so Install again really installs (not done at once)', async () => {
  const w = world('badbin');
  w.installer.start({ harness: 'codex' });
  await until(() => w.installer.status('codex')?.state === 'failed');
  assert.equal(fs.existsSync(path.join(w.prefix, 'bin', 'codex')), false);
  w.env.FAKE_NPM_MODE = 'ok';
  const again = w.installer.start({ harness: 'codex' });
  assert.equal(again.state, 'queued', 'it runs again rather than reading the broken one as installed');
  await until(() => again.state === 'done');
  assert.equal(again.version, '1.2.3 (fake)');
});

test('A: Install right after Cancel starts a new install behind the one still ending, never joins it', async () => {
  const w = world('stubborn', { killMs: 200 });
  w.env.FAKE_NPM_ONLY = 'gemini';
  const first = w.installer.start({ harness: 'gemini' });
  await until(() => w.runs().length === 1);
  assert.equal(w.installer.cancel('gemini'), true);
  assert.equal(first.state, 'cancelled', 'it reads as cancelled at once');
  assert.equal(w.installer.cancel('gemini'), false, 'nothing more to cancel');
  assert.equal(w.installer.idle(), false, 'its npm is still exiting');
  w.env.FAKE_NPM_ONLY = 'nothing';
  w.env.FAKE_NPM_BIN = 'gemini';
  const second = w.installer.start({ harness: 'gemini' });
  assert.notEqual(second, first);
  await until(() => second.state === 'done');
  assert.equal(first.state, 'cancelled');
  await until(() => w.installer.idle());
  const starts = w.runs().filter((r) => r.what === 'start').length;
  assert.equal(starts, 2);
});

test('W: an npm an earlier Host left running in the prefix is stopped before the next install; a stale pid file is dropped', async () => {
  const w = world('ok', { killMs: 200 });
  fs.mkdirSync(w.prefix, { recursive: true });
  const orphan = spawn(process.execPath, [FAKE_NPM, '--prefix', w.prefix, 'x'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FAKE_NPM_MODE: 'stubborn', FAKE_NPM_LOG: path.join(w.root, 'orphan.log') },
  });
  fs.writeFileSync(path.join(w.prefix, '.npm.pid'), String(orphan.pid));
  await until(() => fs.existsSync(path.join(w.root, 'orphan.log')));
  const exited = new Promise((r) => orphan.once('exit', r));
  w.installer.start({ harness: 'codex' });
  await exited;
  await until(() => w.installer.status('codex')?.state === 'done');
  assert.equal(fs.existsSync(path.join(w.prefix, '.npm.pid')), false);
  // a pid file naming a process that is gone, or nothing readable, does not hold the next install
  const stale = world('ok');
  fs.mkdirSync(stale.prefix, { recursive: true });
  fs.writeFileSync(path.join(stale.prefix, '.npm.pid'), 'not a pid');
  stale.installer.start({ harness: 'codex' });
  await until(() => stale.installer.status('codex')?.state === 'done');
  assert.equal(fs.existsSync(path.join(stale.prefix, '.npm.pid')), false);
});

test('I: a pid file from before a reboot whose pid now names another process signals nothing, and the install goes on', async (t) => {
  const w = world('ok');
  fs.mkdirSync(w.prefix, { recursive: true });
  // a group of its own, as `process.kill(-pid)` would reach
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { detached: true, stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  await new Promise((r) => other.once('spawn', r));
  const file = path.join(w.prefix, '.npm.pid');
  fs.writeFileSync(file, String(other.pid));
  const then = new Date(Date.now() - 3_600_000);
  fs.utimesSync(file, then, then);
  w.installer.start({ harness: 'codex' });
  await until(() => w.installer.status('codex')?.state === 'done');
  assert.equal(other.exitCode, null);
  assert.equal(other.signalCode, null);
  assert.equal(fs.existsSync(file), false);
});

test('I: an npm killed from outside says it was stopped', () => {
  assert.equal(npmReason([], null), 'npm was stopped before it finished.');
});

test('W: a Host with no PATH at all still finds the npm beside its Node', async () => {
  const w = world('ok');
  delete (w.env as any).PATH;
  w.installer.start({ harness: 'codex' });
  await until(() => w.installer.status('codex')?.state === 'done');
});

test('I: a long npm failure keeps only its last lines for the reason', async () => {
  const w = world('chatty');
  w.installer.start({ harness: 'codex' });
  await until(() => w.installer.status('codex')?.state === 'failed');
  assert.equal(w.installer.status('codex')!.error, 'line 58 line 59 line 60');
});

test('I: a CLI that cannot be run, exits with nothing said, or prints no version', async () => {
  const nonexec = world('nonexec');
  nonexec.installer.start({ harness: 'codex' });
  await until(() => nonexec.installer.status('codex')?.state === 'failed');
  assert.match(String(nonexec.installer.status('codex')!.error), /^Codex was installed but does not start: spawn .*EACCES/);
  const mute = world('mutebin');
  mute.installer.start({ harness: 'codex' });
  await until(() => mute.installer.status('codex')?.state === 'failed');
  assert.equal(mute.installer.status('codex')!.error, 'Codex was installed but does not start: code 2');
  const quiet = world('quietbin');
  quiet.installer.start({ harness: 'codex' });
  await until(() => quiet.installer.status('codex')?.state === 'done');
  assert.equal(quiet.installer.status('codex')!.version, null);
});

test('A: a child that cannot be signalled as a group is killed alone', async () => {
  // a pid that is no process group: the kill falls back to the process itself
  let killed = 0;
  const lone = world('hang', {
    spawnFn: (bin: string, args: string[], opts: any) => {
      const child: any = spawn(bin, args, opts);
      const real = child.pid;
      Object.defineProperty(child, 'pid', { value: 99_999_999 });
      child.kill = () => (killed++, process.kill(real, 'SIGKILL'));
      return child;
    },
  });
  lone.installer.start({ harness: 'codex' });
  await until(() => lone.runs().length === 1);
  lone.installer.cancel('codex');
  await until(() => lone.installer.idle());
  assert.equal(killed, 1);
});

test('A: an orphan npm that is not a group of its own is waited for; a cancel while it is reaped runs nothing', async () => {
  const w = world('ok', { killMs: 100 });
  fs.mkdirSync(w.prefix, { recursive: true });
  // a process in the test's own group: signalling its "group" fails, so the Host can only wait for it
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(w.prefix, '.npm.pid'), String(orphan.pid));
    w.installer.start({ harness: 'codex' });
    await until(() => w.installer.status('codex')?.state === 'running');
    w.installer.cancel('codex');
    await until(() => w.installer.idle(), 4000);
    assert.equal(w.installer.status('codex')!.state, 'cancelled');
    assert.deepEqual(w.runs(), [], 'npm never started');
    assert.equal(fs.existsSync(path.join(w.prefix, '.npm.pid')), false);
  } finally {
    orphan.kill('SIGKILL');
  }
});
