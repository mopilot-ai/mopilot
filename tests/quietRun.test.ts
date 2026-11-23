// electron/harness/quietRun.cjs: an update nobody watches, run with stdin closed and no colours, its output passed
// on, ended once (close, error or timeout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { spawnQuiet, QUIET_ENV } = require('../electron/harness/quietRun.cjs');

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
function setup() {
  const seen: any[] = [];
  const child = fakeChild();
  const io = {
    spawn: (file: string, args: string[], options: any) => (seen.push(['spawn', file, args, options]), child),
    kill: (p: any) => seen.push(['kill', p === child]),
    args: (bin: string, args: string[], options: any) => [bin, args, options],
  };
  const out: string[] = [];
  const exits: any[] = [];
  const on = { onData: (d: string) => out.push(d), onExit: (e: any) => exits.push(e) };
  return { seen, child, io, out, exits, on };
}

test('runs in the folder and environment given, with nothing asking and nothing coloured; output and retirement come through once', async () => {
  const s = setup();
  const h = spawnQuiet(['/n/npm', 'install', '-g', 'x@latest'], { cwd: '/home/ada', env: { PATH: '/n', NO_COLOR: '0' } }, s.on, s.io);
  const [, file, args, options] = s.seen[0];
  assert.equal(file, '/n/npm');
  assert.deepEqual(args, ['install', '-g', 'x@latest']);
  assert.equal(options.cwd, '/home/ada');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(options.env, { PATH: '/n', ...QUIET_ENV });
  s.child.stdout.emit('data', Buffer.from('added 1\n'));
  s.child.stderr.emit('data', Buffer.from('warn\n'));
  s.child.emit('close', 0);
  s.child.emit('close', 0);
  await tick();
  assert.deepEqual(s.out, ['added 1\n', 'warn\n']);
  assert.deepEqual(s.exits, [{ exitCode: 0 }]);
  h.kill();
  assert.deepEqual(s.seen.at(-1), ['kill', true]);
});

test("a program that can't start says why and ends; a run past its time is stopped and ends", async (t) => {
  const s = setup();
  t.after(() => s.child.emit('close', null));
  spawnQuiet(['/missing'], { cwd: '/', env: {} }, s.on, s.io);
  s.child.emit('error', new Error('spawn /missing ENOENT'));
  assert.deepEqual(s.out, ['\r\nFile or program not found.\r\n']);
  assert.deepEqual(s.exits, [], 'even a failed spawn waits for its close boundary');
  s.child.emit('close', null);
  await tick();
  assert.deepEqual(s.exits, [{ exitCode: null }]);
  const slow = setup();
  t.after(() => slow.child.emit('close', null));
  spawnQuiet(['/slow'], { cwd: '/', env: {}, timeoutMs: 60_000 * 2 + 10 }, slow.on, slow.io);
  // a real timer: shortened through the option
  const u = setup();
  t.after(() => u.child.emit('close', null));
  spawnQuiet(['/slow'], { cwd: '/', env: {}, timeoutMs: 5 }, u.on, u.io);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(u.out, ['\r\n[stopping after 0 minutes]\r\n']);
  assert.deepEqual(u.exits, [], 'timeout requests retirement while preserving run ownership');
  assert.deepEqual(u.seen.at(-1), ['kill', true]);
  u.child.emit('close', 143);
  await tick();
  assert.deepEqual(u.exits, [{ exitCode: null }]);
  assert.equal(u.exits.length, 1);
  slow.child.emit('close', 0);
  await tick();
});

test('failed process verification shows a readable reason, keeps its raw diagnostic and never releases the run', async () => {
  const s = setup();
  const raw = Object.assign(new Error("EACCES: permission denied, open '/private/test-owned-installer/manifest'"), { code: 'EACCES' });
  const handle = spawnQuiet(['/package'], { cwd: '/', env: {} }, s.on, {
    ...s.io,
    kill: async () => {
      throw raw;
    },
  });
  handle.kill();
  s.child.emit('close', 0);
  await tick();
  assert.deepEqual(s.out, ['\r\n[process cleanup failed: Permission denied.]\r\n']);
  assert.deepEqual(s.exits, []);
  const diagnostic = require('../electron/ignored.cjs')
    .recentIgnored()
    .find((item: any) => item.context === 'verify package process cleanup');
  assert.match(diagnostic.message, /EACCES.*test-owned-installer/);
});

test("defaults: Node's spawn through spawnArgs; unavailable identity refuses before execution", async () => {
  const out: string[] = [];
  if (process.platform === 'win32') {
    assert.throws(
      () =>
        spawnQuiet(
          [process.execPath, '-e', 'process.stdout.write("hi")'],
          { cwd: process.cwd(), env: { ...process.env } },
          { onData() {}, onExit() {} },
        ),
      /cannot verify package installer shutdown|unavailable on Windows/,
    );
    return;
  }
  const finished = new Promise((resolve) => {
    spawnQuiet(
      [process.execPath, '-e', 'process.stdout.write("hi")'],
      { cwd: process.cwd(), env: { ...process.env } },
      {
        onData: (data: string) => {
          out.push(data);
        },
        onExit: (event: any) => {
          resolve(event.exitCode);
        },
      },
    );
  });
  assert.equal(await finished, 0);
  assert.equal(out.join('').startsWith('hi'), true);
});
