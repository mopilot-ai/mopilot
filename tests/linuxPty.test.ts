// Linux's native terminal uses forkpty and never tries to chmod a macOS-only spawn helper.
import { test, mock } from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { defaultShell: environmentShell } = createRequire(import.meta.url)('../electron/platform/env.cjs');
const { openPty, loginShell, spawnSpec } = createRequire(import.meta.url)('../electron/platform/pty.cjs');

test('opening the Linux terminal loads node-pty without accessing a spawn-helper file', () => {
  const terminal = { spawn: () => 'terminal' };
  const asked: string[] = [];
  const got = openPty({
    platform: 'linux',
    arch: 'arm64',
    dir: '/staged/node-pty',
    load: (file: string) => {
      asked.push(file);
      return terminal;
    },
    fsm: new Proxy({}, { get: () => assert.fail('Linux has no spawn helper to probe or chmod') }),
  });
  assert.equal(got, terminal);
  assert.deepEqual(asked, ['node-pty']);
});

test('a Linux terminal falls back to sh when the account and environment have no login shell', () => {
  const probe = mock.method(os, 'userInfo', () => {
    throw new Error('no passwd entry');
  });
  try {
    assert.equal(loginShell({}, 'linux'), '/bin/sh');
    assert.equal(environmentShell({}, 'linux'), '/bin/sh');
    assert.equal(environmentShell({}, 'darwin'), '/bin/zsh');
    assert.equal(loginShell({}, 'darwin'), '/bin/zsh');
    assert.equal(loginShell({ SHELL: '/bin/fish' }, 'linux'), '/bin/fish');
    assert.equal(loginShell({}, 'win32'), 'powershell.exe');
    assert.equal(spawnSpec({}, { platform: 'linux', env: {}, home: '/home/user' }).file, '/bin/sh');
  } finally {
    probe.mock.restore();
  }
});
