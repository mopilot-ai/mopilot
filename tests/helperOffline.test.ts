// A read of the helper's macOS grants by a helper that is not running (#2528, electron/platform/helperOffline.cjs): launched once through LaunchServices with the kind's flag and an output file, its answer read back and the file always removed; a launch that fails, ends badly or never answers is an error, never a stale answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { offlineStatus, FLAGS } = require('../electron/platform/helperOffline.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-offline-'));
const left = () => fs.readdirSync(dir);

/** A stand-in for `open -W`: records the call and, as the helper would, writes the answer where --out says, then exits with `code`. */
function fakeSpawn(o: { answer?: unknown; code?: number; error?: Error; hang?: boolean; writeNothing?: boolean } = {}) {
  const calls: any[] = [];
  const kills: number[] = [];
  const spawn = (cmd: string, args: string[], opts: object) => {
    calls.push([cmd, args, opts]);
    const child: any = new EventEmitter();
    child.kill = () => kills.push(1);
    setImmediate(() => {
      if (o.error) return child.emit('error', o.error);
      if (o.hang) return;
      if (!o.writeNothing) fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(o.answer ?? {}));
      child.emit('exit', o.code ?? 0);
    });
    return child;
  };
  return { spawn, calls, kills };
}

test('each kind launches the helper once through open with its flag and an output file, and reads the answer; the file is removed', async () => {
  assert.deepEqual(FLAGS, { eventkit: '--eventkit-status', permissions: '--permissions-status' });
  const f = fakeSpawn({ answer: { calendar: 'granted', reminders: 'denied' } });
  const helper = { appPath: '/Apps/MoPilot.app', spawn: f.spawn };
  assert.deepEqual(await offlineStatus(helper, 'eventkit', { dir }), { calendar: 'granted', reminders: 'denied' });
  const [cmd, args, opts] = f.calls[0];
  assert.equal(cmd, '/usr/bin/open');
  assert.deepEqual(args.slice(0, 6), ['-n', '-g', '-W', '-a', '/Apps/MoPilot.app', '--args']);
  assert.equal(args[6], '--eventkit-status');
  assert.equal(args[7], '--out');
  assert.ok(args[8].startsWith(dir));
  assert.deepEqual(opts, { stdio: 'ignore' });
  assert.deepEqual(left(), []);
  const g = fakeSpawn({ answer: { accessibility: true, screenRecording: false, inputMonitoring: false } });
  assert.deepEqual(await offlineStatus({ appPath: '/A.app', spawn: g.spawn }, 'permissions', { dir }), {
    accessibility: true,
    screenRecording: false,
    inputMonitoring: false,
  });
  assert.equal(g.calls[0][1][6], '--permissions-status');
});

test('a launch that cannot start, ends badly, never answers or leaves no answer is an error, and nothing is left behind', async () => {
  const base = { appPath: '/A.app' };
  await assert.rejects(offlineStatus({ ...base, spawn: fakeSpawn({ error: new Error('no open') }).spawn }, 'eventkit', { dir }), /no open/);
  await assert.rejects(offlineStatus({ ...base, spawn: fakeSpawn({ code: 74 }).spawn }, 'eventkit', { dir }), /ended with 74/);
  const hang = fakeSpawn({ hang: true });
  await assert.rejects(offlineStatus({ ...base, spawn: hang.spawn }, 'eventkit', { dir, timeoutMs: 20 }), /did not answer/);
  assert.equal(hang.kills.length, 1, 'the launch is stopped');
  await assert.rejects(offlineStatus({ ...base, spawn: fakeSpawn({ writeNothing: true }).spawn }, 'permissions', { dir }), /ENOENT/);
  assert.deepEqual(left(), []);
});

test('with no spawn of its own the real one is used (a program that answers nothing fails the read)', async () => {
  await assert.rejects(offlineStatus({ appPath: '/A.app' }, 'eventkit', { dir, bin: '/usr/bin/true' }), /ENOENT/);
  assert.deepEqual(left(), []);
});

// #2999: macOS's record of the helper's Calendar or Reminders answer is cleared with tccutil when a request got no prompt.
test('resetGrant clears one source’s record of the helper through tccutil and says whether it worked', async () => {
  const { resetGrant } = require('../electron/platform/helperOffline.cjs');
  const calls: any[] = [];
  const exec = (code: number | null) => (cmd: string, args: string[], opts: any, cb: (e: Error | null) => void) => {
    calls.push([cmd, args, opts]);
    cb(code === 0 ? null : Object.assign(new Error('tccutil failed'), { code }));
  };
  assert.equal(await resetGrant('calendar', { bundleId: 'ai.example.helper', exec: exec(0) }), true);
  assert.equal(await resetGrant('reminders', { bundleId: 'ai.example.helper', exec: exec(0) }), true);
  assert.deepEqual(
    calls.map(([cmd, args]) => [cmd, args]),
    [
      ['/usr/bin/tccutil', ['reset', 'Calendar', 'ai.example.helper']],
      ['/usr/bin/tccutil', ['reset', 'Reminders', 'ai.example.helper']],
    ],
  );
  assert.ok(calls[0][2].timeout > 0, 'it cannot hang');
  assert.equal(await resetGrant('calendar', { bundleId: 'ai.example.helper', exec: exec(1) }), false);
  // only the two EventKit sources have a service to reset, and never without the helper's own bundle id
  assert.equal(await resetGrant('files', { bundleId: 'ai.example.helper', exec: exec(0) }), false);
  assert.equal(await resetGrant('calendar', { bundleId: '', exec: exec(0) }), false);
  assert.equal(calls.length, 3, 'neither of the last two ran tccutil');
});
