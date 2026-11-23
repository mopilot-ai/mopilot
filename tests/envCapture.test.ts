// electron/platform/env.cjs with a fake spawn: login-shell capture failures, init's cached result,
// Windows behaviour and the small helpers' edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const envPath = require.resolve('../electron/platform/env.cjs');
const env = require(envPath);

function fakeProc(pid = 4242) {
  const p = Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    killed: [] as string[],
    kill: (s: string) => p.killed.push(s),
  });
  return p;
}

test('defaultShell: $SHELL, then the passwd shell, then the platform fallback', (t) => {
  const ui = t.mock.method(os, 'userInfo', () => ({ shell: '/bin/bash' }));
  for (const [platform, fallback] of [
    ['darwin', '/bin/zsh'],
    ['linux', '/bin/sh'],
  ] as const) {
    ui.mock.mockImplementation(() => ({ shell: '/bin/bash' }) as any);
    assert.equal(env.defaultShell({ SHELL: '/bin/fish' }, platform), '/bin/fish');
    assert.equal(env.defaultShell({}, platform), '/bin/bash');
    ui.mock.mockImplementation(() => ({ shell: '' }) as any);
    assert.equal(env.defaultShell({}, platform), fallback);
    ui.mock.mockImplementation(() => {
      throw new Error('no passwd');
    });
    assert.equal(env.defaultShell({}, platform), fallback);
    assert.equal(env.defaultShell({ SHELL: '/bin/fish' }, platform), '/bin/fish');
  }
  assert.equal(env.defaultShell({}), process.platform === 'linux' ? '/bin/sh' : '/bin/zsh');
  // the default argument is this process's env
  assert.equal(typeof env.defaultShell(), 'string');
});

test('helpers tolerate missing input and skip invalid keys and empty values', () => {
  assert.deepEqual(env.pickCloud(undefined), {});
  assert.deepEqual(env.pickCloud({ CLAUDE_CODE_USE_BEDROCK: null, CLAUDE_CODE_USE_VERTEX: 1 }), { CLAUDE_CODE_USE_VERTEX: '1' });
  assert.deepEqual(env.parseEnv0(undefined), {});
  assert.deepEqual(env.parseEnv0('1BAD=x\0OK=y\0'), { OK: 'y' });
  assert.deepEqual(env.scrubSnapshot(undefined), {});
  // a home with no user-tool folders adds nothing past the system ones
  const home = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'widen-home-'));
  try {
    assert.equal(env.widenPath(undefined, {}), '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  } finally {
    process.env.HOME = home;
  }
});

test('capture: a spawn that throws resolves with its message (or the value itself)', async () => {
  assert.deepEqual(
    await env.capture({
      shell: '/bin/sh',
      env: {},
      spawnFn: () => {
        throw new Error('EPERM');
      },
    }),
    { ok: false, env: null, error: 'EPERM' },
  );
  assert.deepEqual(
    await env.capture({
      shell: '/bin/sh',
      env: {},
      spawnFn: () => {
        throw 'weird';
      },
    }),
    { ok: false, env: null, error: 'weird' },
  );
});

test('capture: the base env carries only the locale/identity variables that are set', async () => {
  let seen: any;
  const p = fakeProc();
  const r = env.capture({
    shell: '/bin/sh',
    env: { HOME: '/h', LANG: '', SECRET: 's' },
    spawnFn: (_s: string, _a: string[], o: any) => {
      seen = o;
      queueMicrotask(() => {
        p.stdout.emit('data', Buffer.from(`${env.MARKER}\0PATH=/x\0`));
        p.emit('close', 0);
      });
      return p;
    },
  });
  assert.deepEqual(await r, { ok: true, env: { PATH: '/x' }, error: null });
  assert.deepEqual(seen.env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb', HOME: '/h', SHELL: '/bin/sh' });
});

test('capture: a process error resolves once with its message or value', async () => {
  for (const [err, msg] of [
    [new Error('ENOENT'), 'ENOENT'],
    ['raw', 'raw'],
  ] as const) {
    const p = fakeProc();
    const r = env.capture({
      shell: '/bin/sh',
      env: {},
      spawnFn: () => {
        queueMicrotask(() => {
          p.emit('error', err);
          p.emit('close', 1);
        });
        return p;
      },
    });
    assert.deepEqual(await r, { ok: false, env: null, error: msg });
  }
});

test('capture: on timeout the process group is killed, falling back to the process, errors ignored', async (t) => {
  const kill = t.mock.method(process, 'kill', () => {
    throw new Error('ESRCH');
  });
  let p = fakeProc(999999);
  let r = await env.capture({ shell: '/bin/sh', env: {}, timeoutMs: 1, spawnFn: () => p });
  assert.deepEqual(r, { ok: false, env: null, error: 'login shell timed out after 1 ms' });
  assert.deepEqual(kill.mock.calls[0].arguments, [-999999, 'SIGKILL']);
  assert.deepEqual(p.killed, ['SIGKILL']);
  p = fakeProc(999998);
  p.kill = () => {
    throw new Error('dead');
  };
  r = await env.capture({ shell: '/bin/sh', env: {}, timeoutMs: 1, spawnFn: () => p });
  assert.equal(r.ok, false);
});

test('init: a failed capture leaves no snapshot and reports the error; ready() and cloudVars()', async () => {
  delete require.cache[envPath];
  const fresh = require(envPath);
  assert.equal(await fresh.ready(), false, 'not started');
  const p = fakeProc();
  const r = fresh.init({
    shell: '/bin/sh',
    env: {},
    spawnFn: () => {
      queueMicrotask(() => p.emit('close', 1));
      return p;
    },
  });
  assert.equal(fresh.ready(), r);
  assert.equal(await r, false);
  assert.deepEqual(fresh.status(), { captured: false, error: 'login shell exited 1 without an environment' });
  assert.deepEqual(fresh.cloudVars(), {});
});

test('init: a captured env keeps the cloud switches apart', async () => {
  delete require.cache[envPath];
  const fresh = require(envPath);
  const p = fakeProc();
  const ok = await fresh.init({
    shell: '/bin/sh',
    env: {},
    spawnFn: () => {
      queueMicrotask(() => {
        p.stdout.emit('data', Buffer.from(`${fresh.MARKER}\0PATH=/x\0CLAUDE_CODE_USE_BEDROCK=1\0`));
        p.emit('close', 0);
      });
      return p;
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(fresh.cloudVars(), { CLAUDE_CODE_USE_BEDROCK: '1' });
  assert.deepEqual(fresh.status(), { captured: true, error: null });
});

test('Windows: init does not run a shell unless a spawnFn is given', async (t) => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  delete require.cache[envPath];
  let win: any;
  try {
    win = require(envPath);
  } finally {
    Object.defineProperty(process, 'platform', orig);
    delete require.cache[envPath];
  }
  t.after(() => delete require.cache[envPath]);
  assert.equal(await win.init(), false);
  assert.equal(await win.init({ shell: 'x' }), false);
  // with a spawnFn (tests), a fresh copy captures as usual
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    delete require.cache[envPath];
    win = require(envPath);
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
  const p = fakeProc();
  assert.equal(
    await win.init({
      shell: 'x',
      env: {},
      spawnFn: () => {
        queueMicrotask(() => p.emit('close', 0));
        return p;
      },
    }),
    false,
  );
});

test('which on Windows follows PATH and PATHEXT and returns the first existing file', (t) => {
  const exists = t.mock.method(fs, 'existsSync', (p: string) => p === 'C:\\bin\\tool.exe');
  assert.equal(env.which('tool', 'C:\\nope;C:\\bin', 'win32'), 'C:\\bin\\tool.exe');
  exists.mock.mockImplementation(() => false);
  assert.equal(env.which('tool', null, 'win32'), null);
});

test('childEnv on Windows is this env as strings, without unset values or PATH widening', () => {
  assert.deepEqual(env.childEnv({ Path: 'C:\\x', N: 1, U: undefined }, { PATH: '/snap' }, 'win32'), { Path: 'C:\\x', N: '1' });
});

test('which skips empty PATH entries', () => {
  assert.equal(env.which('definitely-not-a-binary-xyz', '::/nonexistent-dir', 'darwin'), null);
});
