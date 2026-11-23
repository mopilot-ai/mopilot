// The commands main runs itself (git and gh for PR status, the PR monitor and the gh:run IPC; ripgrep for file search)
// get the login shell's environment: an app opened from the Dock has launchd's PATH, where Homebrew's gh is not (#1580).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const shellEnv = require('../electron/platform/env.cjs');

test('run gives the command the login-shell PATH when the app has launchd’s, and an explicit env still wins', async (t) => {
  t.mock.method(shellEnv, 'gitEnv', () => ({ PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: '/Users/me' }));
  const seen: Record<string, unknown>[] = [];
  t.mock.method(childProcess, 'execFile', (_cmd: string, _args: string[], opts: Record<string, unknown>, cb: Function) => {
    seen.push(opts);
    cb(null, 'ok\n', '');
  });
  // loaded after the mock, so its execFile is the mocked one
  delete require.cache[require.resolve('../electron/app/commands.cjs')];
  const { run } = require('../electron/app/commands.cjs');
  assert.deepEqual(await run('gh', ['pr', 'view']), { ok: true, code: 0, stdout: 'ok\n', stderr: '' });
  assert.equal((seen[0].env as Record<string, string>).PATH, '/opt/homebrew/bin:/usr/bin:/bin');
  await run('git', ['status'], { env: { PATH: '/custom' } });
  assert.deepEqual(seen[1].env, { PATH: '/custom' });
  delete require.cache[require.resolve('../electron/app/commands.cjs')];
});

test('run finds a gh that is only on the login-shell PATH, as a Dock launch does', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-gh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "gh $1"\n', { mode: 0o755 });
  t.mock.method(shellEnv, 'gitEnv', () => ({ PATH: `${dir}:/usr/bin:/bin` }));
  delete require.cache[require.resolve('../electron/app/commands.cjs')];
  const { run } = require('../electron/app/commands.cjs');
  const saved = process.env.PATH;
  // launchd's PATH: without the login shell's, gh is not found
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    assert.deepEqual(await run('gh', ['auth']), { ok: true, code: 0, stdout: 'gh auth\n', stderr: '' });
  } finally {
    process.env.PATH = saved;
    delete require.cache[require.resolve('../electron/app/commands.cjs')];
  }
});

test('file search runs ripgrep with the login-shell environment', async (t) => {
  t.mock.method(shellEnv, 'childEnv', () => ({ PATH: '/opt/homebrew/bin:/usr/bin' }));
  const seen: Record<string, unknown>[] = [];
  const { EventEmitter } = require('node:events');
  t.mock.method(childProcess, 'spawn', (_bin: string, _args: string[], opts: Record<string, unknown>) => {
    seen.push(opts);
    const proc = new EventEmitter();
    proc.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    proc.kill = () => {};
    setImmediate(() => proc.emit('close', 0));
    return proc;
  });
  const { listFiles } = require('../electron/platform/search.cjs');
  assert.deepEqual(await listFiles(process.cwd(), { bin: 'rg' }), []);
  assert.deepEqual(seen[0].env, { PATH: '/opt/homebrew/bin:/usr/bin' });
});

test('gitEnv keeps the login-shell PATH but drops the GIT_* variables that would point git at another repository', () => {
  const vars = { GIT_DIR: '/Users/me/.dotfiles', GIT_WORK_TREE: '/Users/me', GIT_INDEX_FILE: '/tmp/i', GIT_AUTHOR_NAME: 'Me' };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    const env = shellEnv.gitEnv();
    assert.equal(env.PATH, shellEnv.childEnv().PATH);
    assert.equal(env.GIT_AUTHOR_NAME, 'Me');
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) assert.equal(env[k], undefined, k);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
