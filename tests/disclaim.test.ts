// electron/platform/disclaim.cjs (the wrapping) and native/disclaim (the launcher, built for real on a Mac).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDisclaim } from '../scripts/build-disclaim.mjs';

const require = createRequire(import.meta.url);
const disclaim = require('../electron/platform/disclaim.cjs');
const { spawnArgs } = require('../electron/platform/winbin.cjs');

const on = (p = '/x/disclaim', extra: any = {}) =>
  disclaim.configure({ launcher: p, platform: 'darwin', env: { MOPILOT_DISCLAIM: '1' }, exists: () => true, ...extra });
test.afterEach(() => disclaim.configure({}));

test('launcher path: Contents/Helpers when packaged, native/disclaim/build in a checkout', () => {
  assert.equal(disclaim.disclaimPath({ packaged: true, resourcesPath: '/A.app/Contents/Resources' }), '/A.app/Contents/Helpers/disclaim');
  assert.equal(disclaim.disclaimPath({ repoRoot: '/repo' }), '/repo/native/disclaim/build/disclaim');
});

test('commands go through the launcher on macOS only, only when it exists and only when opted in', () => {
  on();
  assert.deepEqual(disclaim.wrap('codex', ['app-server']), { command: '/x/disclaim', args: ['codex', 'app-server'] });
  disclaim.configure({ launcher: '/x/disclaim', platform: 'linux', exists: () => true });
  assert.deepEqual(disclaim.wrap('codex', ['a']), { command: 'codex', args: ['a'] });
  on('/x/disclaim', { exists: () => false });
  assert.equal(disclaim.active(), null);
  on('/x/disclaim', { env: {} });
  assert.equal(disclaim.active(), null);
  on('/x/disclaim', { env: {} });
  assert.equal(disclaim.active(), null);
  on('/x/disclaim', { env: { MOPILOT_DISCLAIM: '0' } });
  assert.equal(disclaim.active(), null);
  assert.deepEqual(disclaim.wrap('sh'), { command: 'sh', args: [] });
});

test('spawnArgs wraps the resolved program and keeps its options', { skip: process.platform === 'win32' }, () => {
  on();
  const [cmd, args, opts] = spawnArgs('/bin/echo', ['hi'], { cwd: '/tmp' });
  assert.equal(cmd, '/x/disclaim');
  assert.deepEqual(args, ['/bin/echo', 'hi']);
  assert.equal(opts.cwd, '/tmp');
});

test('an SDK program becomes a small script that execs it through the launcher; node scripts are left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disclaim-'));
  on('/Apps/My App/disclaim', { dir: () => dir });
  const script = disclaim.wrapProgram("/opt/it's/claude");
  assert.equal(path.dirname(script), dir);
  assert.equal(fs.readFileSync(script, 'utf8'), `#!/bin/sh\nexec '/Apps/My App/disclaim' '/opt/it'\\''s/claude' "$@"\n`);
  assert.ok(fs.statSync(script).mode & 0o100);
  assert.equal(disclaim.wrapProgram("/opt/it's/claude"), script);
  assert.equal(disclaim.wrapProgram('/opt/claude/cli.js'), '/opt/claude/cli.js');
  disclaim.configure({});
  assert.equal(disclaim.wrapProgram('/opt/claude'), '/opt/claude');
  fs.rmSync(dir, { recursive: true, force: true });
});

const skip = process.platform !== 'darwin' || spawnSync('swift', ['--version'], { stdio: 'ignore' }).status !== 0;
test('real launcher: execs in place (same pid, exit code, errors) and the command is its own responsible process', {
  skip,
  timeout: 600_000,
}, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'disclaim-build-'));
  try {
    const bin = buildDisclaim({ out, log: () => {} });
    const run = (...a: string[]) => spawnSync(bin, a, { encoding: 'utf8', cwd: os.tmpdir() });
    assert.equal(run('/bin/sh', '-c', 'exit 3').status, 3);
    assert.equal(run('/nonexistent/program').status, 127);
    assert.equal(spawnSync(bin, [], { encoding: 'utf8' }).status, 64);
    // exec, not fork: the program's pid is the launcher's
    const pid = spawnSync(bin, ['/bin/sh', '-c', 'echo $$'], { encoding: 'utf8' });
    assert.ok(Number(pid.stdout) > 1);
    // responsible for itself, so TCC does not attribute it to whoever started the launcher
    const py = 'import ctypes,os; print(os.getpid(), ctypes.CDLL(None).responsibility_get_pid_responsible_for_pid(os.getpid()))';
    if (spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0) {
      const r = run('python3', '-c', py);
      const [self, responsible] = r.stdout.trim().split(' ');
      assert.equal(responsible, self, r.stderr);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
