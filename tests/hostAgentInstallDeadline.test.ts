// Host installer cancellation and deadline overlap are tested on a controlled clock without racing real process startup.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';

const { createInstaller } = createRequire(import.meta.url)('../host/src/agentInstall.mjs');

async function fixture(t: TestContext, { installMs = 150, closeOnTerm = false, harness = 'codex' } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-install-deadline-'));
  const children: any[] = [];
  const started = deferred<void>();
  const signals: (string | number | undefined)[] = [];
  t.mock.method(process, 'kill', (pid: number, signal: string | number | undefined) => {
    const child = children.find((item) => item.pid === -pid);
    assert.ok(child, 'signals belong to this fixture');
    signals.push(signal);
    if (signal === 'SIGKILL') child.emit('close', null);
    if (signal === 'SIGTERM' && closeOnTerm) setImmediate(() => child.emit('close', null));
    return true;
  });
  const installer = createInstaller({
    dataDir: root,
    env: { PATH: '/fixture' },
    platform: 'linux',
    which: (name: string) => (name === 'npm' ? '/fixture/npm' : null),
    spawnFn: () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 900_001 + children.length,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        closed: false,
        kill: t.mock.fn(() => assert.fail('the existing process group handles the stop')),
      });
      child.once('close', () => {
        child.closed = true;
      });
      children.push(child);
      started.resolve();
      return child;
    },
    installMs,
    killMs: 400,
  });
  t.after(async () => {
    installer.close();
    for (const child of children) if (!child.closed) child.emit('close', null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const child of children) {
      child.stdout.destroy();
      child.stderr.destroy();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  installer.start({ harness });
  await started.promise;
  return { child: children[0], children, installer, signals };
}

test('cancellation owns the stop reason when its install deadline passes during shutdown; the hard kill waits for its boundary', async (t) => {
  const { child, installer, signals } = await fixture(t);
  installer.cancel('codex');
  assert.deepEqual(signals, ['SIGTERM']);
  t.mock.timers.tick(150);
  assert.deepEqual(signals, ['SIGTERM'], 'the later install deadline cannot request a second stop');
  assert.equal(installer.idle(), false, 'the prefix remains owned until the process closes');
  t.mock.timers.tick(249);
  assert.deepEqual(signals, ['SIGTERM'], 'no hard kill before the grace boundary');
  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.kill.mock.callCount(), 0);
  assert.equal(installer.idle(), true);
  assert.equal(installer.status('codex').state, 'cancelled');
});

test('an install deadline stops a running npm and reports its timeout after close, then retires the hard-kill timer', async (t) => {
  const { child, installer, signals } = await fixture(t, { installMs: 300, closeOnTerm: true });
  child.stdout.write('reify: timing\n');
  assert.equal(installer.status('codex').line, 'reify: timing');
  t.mock.timers.tick(299);
  assert.deepEqual(signals, []);
  assert.equal(installer.status('codex').state, 'running');
  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(installer.idle(), true);
  assert.equal(installer.status('codex').state, 'failed');
  assert.equal(installer.status('codex').error, 'The install ran too long and was stopped.');
  t.mock.timers.tick(400);
  assert.deepEqual(signals, ['SIGTERM'], 'closing before the grace boundary retires the hard kill');
});

test('another harness stays queued through the whole hard-kill grace and starts only after the prior process closes', async (t) => {
  const { child, children, installer, signals } = await fixture(t, { harness: 'gemini' });
  const next = installer.start({ harness: 'codex' });
  installer.cancel('gemini');
  t.mock.timers.tick(399);
  assert.equal(next.state, 'queued');
  assert.equal(children.length, 1);
  assert.equal(child.closed, false);
  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(child.closed, true);
  assert.equal(children.length, 2);
  assert.equal(next.state, 'running');
  installer.cancel('codex');
  t.mock.timers.tick(400);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(installer.idle(), true);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL']);
});
