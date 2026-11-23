// electron/platform/git.cjs's environment scripts with a fake pty: env:write and running a setup script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const git = require('../electron/platform/git.cjs');
const pty = require('../electron/platform/pty.cjs');

function tmp(t: any, prefix = 'gitenv-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function ipc() {
  const h = new Map<string, (...a: any[]) => any>();
  git.register({ handle: (ch: string, f: any) => h.set(ch, f) });
  return (ch: string, ...a: any[]) => h.get(ch)!({}, ...a);
}

test('env:write writes environment.toml atomically and reports bad input and failures', (t) => {
  const d = tmp(t);
  const call = ipc();
  assert.deepEqual(call('env:write', d, 'x = 1\n'), { ok: true });
  assert.equal(fs.readFileSync(path.join(d, '.codex', 'environments', 'environment.toml'), 'utf8'), 'x = 1\n');
  assert.deepEqual(call('env:write', 'rel', 'x'), { ok: false, error: 'invalid' });
  assert.deepEqual(call('env:write', d, 3), { ok: false, error: 'invalid' });
  assert.deepEqual(call('env:write', 4, 'x'), { ok: false, error: 'invalid' });
  fs.writeFileSync(path.join(d, 'f'), '');
  assert.match(call('env:write', path.join(d, 'f'), 'x').error, /EEXIST|ENOTDIR/);
  // a rename that fails reports it, keeps the old file and leaves no temporary file behind
  const envDir = path.join(d, '.codex', 'environments');
  const blocked = tmp(t, 'gitenv-blocked-');
  fs.mkdirSync(path.join(blocked, '.codex', 'environments', 'environment.toml'), { recursive: true });
  assert.equal(call('env:write', blocked, 'y = 2\n').ok, false);
  assert.deepEqual(fs.readdirSync(path.join(blocked, '.codex', 'environments')), ['environment.toml']);
  assert.deepEqual(fs.readdirSync(envDir), ['environment.toml']);
  t.mock.method(fs, 'mkdirSync', () => {
    throw 'weird';
  });
  assert.deepEqual(call('env:write', d, 'x'), { ok: false, error: 'weird' });
});

test('runScript: output tail and exit code; timeout kills (124); a spawn failure is 127', async (t) => {
  let handlers: any;
  let spec: any;
  const spawn = t.mock.method(pty, 'spawn', (_id: string, s: any, h: any) => {
    spec = s;
    handlers = h;
  });
  t.mock.method(pty, 'loginShell', () => '/bin/zsh');
  const kill = t.mock.method(pty, 'kill', () => handlers.onExit({ exitCode: 0, killed: true }));
  const p = ipc()('env:runScript', '/repo', 'make setup');
  assert.deepEqual(spec.command, ['/bin/zsh', '-lc', 'make setup']);
  assert.equal(spec.cwd, '/repo');
  // no view answers a setup script: on Windows it answers ConPTY's start-up question itself (pty.cjs)
  assert.equal(spec.selfAnswer, true);
  handlers.onData('x'.repeat(5000));
  handlers.onData('END');
  handlers.onExit({ exitCode: 3, killed: false });
  const r = await p;
  assert.equal(r.exitCode, 3);
  assert.equal(r.output.length, 4000);
  assert.ok(r.output.endsWith('END'));

  assert.deepEqual(await git.runScript('/repo', 'sleep', { timeoutMs: 1 }), { exitCode: 124, output: '' });
  assert.equal(kill.mock.callCount(), 1);

  spawn.mock.mockImplementation(() => {
    throw new Error('no pty');
  });
  assert.deepEqual(await git.runScript('/repo', 'x'), { exitCode: 127, output: 'no pty' });
  spawn.mock.mockImplementation(() => {
    throw 'raw';
  });
  assert.deepEqual(await git.runScript('/repo', 'x'), { exitCode: 127, output: 'raw' });
});

test('runScript on Windows runs PowerShell', async (t) => {
  let spec: any;
  t.mock.method(pty, 'spawn', (_id: string, s: any, h: any) => {
    spec = s;
    setImmediate(() => h.onExit({ exitCode: 0, killed: false }));
  });
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.deepEqual(await git.runScript('C:\\repo', 'npm ci'), { exitCode: 0, output: '' });
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
  assert.deepEqual(spec.command, ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', 'npm ci']);
});
