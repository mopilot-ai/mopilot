// electron/platform/pty.cjs: what a pty request runs, and a real pty round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';

const require = createRequire(import.meta.url);
const pty = require('../electron/platform/pty.cjs');
const { spawnSpec } = pty;

const ctx = {
  shell: '/bin/fish',
  home: '/Users/me',
  env: { PATH: '/usr/bin:/custom', HOME: '/Users/me' },
  isDir: (p: string) => p === '/repo',
};

test('no command runs the login shell as a login shell, in cwd', () => {
  const s = spawnSpec({ cwd: '/repo', cols: 120, rows: 30 }, ctx);
  assert.equal(s.file, '/bin/fish');
  assert.deepEqual(s.args, ['-l']);
  assert.equal(s.cwd, '/repo');
  assert.equal(s.cols, 120);
  assert.equal(s.rows, 30);
  assert.equal(s.env.SHELL, '/bin/fish');
});

test('a command runs as given', () => {
  const s = spawnSpec({ command: ['/usr/bin/ssh', 'host'], cwd: '/repo' }, ctx);
  assert.equal(s.file, '/usr/bin/ssh');
  assert.deepEqual(s.args, ['host']);
  assert.equal(s.env.SHELL, undefined);
});

test('a missing cwd falls back to home; bad sizes to 80x24', () => {
  const s = spawnSpec({ cwd: '/gone', cols: 0, rows: Number.NaN }, ctx);
  assert.equal(s.cwd, '/Users/me');
  assert.equal(s.cols, 80);
  assert.equal(s.rows, 24);
});

test('env: GUI-safe PATH, terminal vars, Electron vars dropped, overrides on top', () => {
  const s = spawnSpec({ env: { FOO: 'bar', HOME: null } }, { ...ctx, env: { ...ctx.env, ELECTRON_RUN_AS_NODE: '1', LANG: 'de_DE.UTF-8' } });
  assert.equal(s.env.PATH.split(':').slice(0, 3).join(':'), '/usr/bin:/custom:/opt/homebrew/bin');
  assert.equal(s.env.PATH.split(':').filter((p: string) => p === '/usr/bin').length, 1);
  assert.equal(s.env.TERM, 'xterm-256color');
  assert.equal(s.env.COLORTERM, 'truecolor');
  assert.equal(s.env.LANG, 'de_DE.UTF-8');
  assert.equal(s.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(s.env.FOO, 'bar');
  assert.equal('HOME' in s.env, false);
  assert.equal(spawnSpec({}, ctx).env.LANG, 'en_US.UTF-8');
});

test("env: the folder's variables go under the request's own, and a failing lookup starts the pty without them", (t) => {
  const seen: string[] = [];
  const cwdEnv = (cwd: string) => (seen.push(cwd), { MOPILOT_PORT: '42000', FOO: 'folder', CONDUCTOR_PORT: null });
  // the app was started from a terminal that had its own values: the folder's null removes the inherited one
  const inherited = { ...ctx, env: { ...ctx.env, CONDUCTOR_PORT: '55100', MOPILOT_PORT: '55100' } };
  const s = spawnSpec({ cwd: '/repo', env: { FOO: 'request' } }, { ...inherited, cwdEnv });
  assert.equal(s.env.MOPILOT_PORT, '42000');
  assert.equal('CONDUCTOR_PORT' in s.env, false);
  assert.equal(s.env.FOO, 'request');
  // a folder that is gone runs in home, and home is what the lookup is asked about
  spawnSpec({ cwd: '/gone' }, { ...ctx, cwdEnv });
  assert.deepEqual(seen, ['/repo', '/Users/me']);
  const broken = spawnSpec(
    { cwd: '/repo' },
    {
      ...ctx,
      cwdEnv: () => {
        throw new Error('unreadable marker');
      },
    },
  );
  assert.equal('MOPILOT_PORT' in broken.env, false);
  assert.equal(spawnSpec({ cwd: '/repo' }, { ...ctx, cwdEnv: null }).env.MOPILOT_PORT, undefined);
  // the registered lookup is the default
  pty.setCwdEnv(() => ({ MOPILOT_WORKSPACE_NAME: 'ab12' }));
  t.after(() => pty.setCwdEnv(null));
  assert.equal(spawnSpec({ cwd: '/repo' }, ctx).env.MOPILOT_WORKSPACE_NAME, 'ab12');
});

test("systemBrowser: a sign-in's URLs skip the $BROWSER shim (its OAuth redirect is a localhost listener)", () => {
  const shimmed = {
    ...ctx.env,
    BROWSER: '/data/bin/mopilot-browser.js',
    MOPILOT_BROWSER_SOCK: '/tmp/s.sock',
    MOPILOT_BROWSER_TOKEN: 't',
    MOPILOT_BROWSER_FALLBACK: 'firefox',
  };
  const shim = (env: Record<string, string>) => Object.keys(env).filter((k) => k.startsWith('MOPILOT_BROWSER'));
  const plain = spawnSpec({ command: ['claude', 'auth', 'login'] }, { ...ctx, env: shimmed });
  assert.equal(plain.env.BROWSER, '/data/bin/mopilot-browser.js', 'other terminals keep the shim');
  const signIn = spawnSpec({ command: ['claude', 'auth', 'login'], systemBrowser: true }, { ...ctx, env: shimmed });
  assert.equal(signIn.env.BROWSER, 'firefox', "the user's own BROWSER");
  assert.deepEqual(shim(signIn.env), []);
  const { MOPILOT_BROWSER_FALLBACK: _f, ...noFallback } = shimmed;
  const bare = spawnSpec({ command: ['claude'], systemBrowser: true, env: { EXTRA: '1' } }, { ...ctx, env: noFallback });
  assert.equal('BROWSER' in bare.env, false, 'no BROWSER: the CLI uses the system opener');
  assert.equal(bare.env.EXTRA, '1');
});

test('spawns a real pty, reports output and exit', async () => {
  const out: string[] = [];
  const exit = await new Promise<{ exitCode: number; killed: boolean }>((resolve) => {
    pty.spawn(
      't1',
      { command: ['/bin/sh', '-c', 'echo pty-$((40+2)); exit 3'], cwd: os.tmpdir() },
      { onData: (d: string) => out.push(d), onExit: resolve },
    );
  });
  assert.match(out.join(''), /pty-42/);
  assert.equal(exit.exitCode, 3);
  assert.equal(exit.killed, false);
  assert.equal(pty.has('t1'), false);
});

test('kill forgets the pty and marks its exit killed', async () => {
  const exit = await new Promise<{ killed: boolean }>((resolve) => {
    pty.spawn('t2', { command: ['/bin/sh', '-c', 'sleep 30'] }, { onExit: resolve });
    assert.equal(pty.kill('t2'), true);
    assert.equal(pty.has('t2'), false);
  });
  assert.equal(exit.killed, true);
});

test('pause and resume stop and restart reading a pty, and ignore ids that are not open', async () => {
  assert.equal(pty.pause('nope'), undefined);
  assert.equal(pty.resume('nope'), undefined);
  const out: string[] = [];
  const exit = new Promise<{ exitCode: number }>((resolve) => {
    pty.spawn('t4', { command: ['/bin/sh', '-c', 'sleep 0.3; echo after-pause'] }, { onData: (d: string) => out.push(d), onExit: resolve });
  });
  pty.pause('t4');
  pty.resume('t4');
  await exit;
  assert.match(out.join(''), /after-pause/);
});
