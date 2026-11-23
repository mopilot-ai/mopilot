// The programs Host starts and waits on are stopped when the app quits (electron/host/started.cjs): a Bonjour browse that never ends by itself, still running when the machines service is disposed at quit, is killed rather than orphaned (an orphan keeps the pipes it inherited open, which held the E2E harness's app.close() for a minute); one that ended is no longer followed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const started = require('../electron/host/started.cjs');
const { collect } = require('../electron/host/discovery.cjs');
const { createMachines } = require('../electron/host/machines.cjs');

class Child extends EventEmitter {
  killed: string[] = [];
  kill = (signal: string) => (this.killed.push(signal), true);
}

test('a program is followed until it ends; the ones still running are stopped, once', () => {
  const done = started.track(new Child());
  const running = started.track(new Child());
  assert.equal(started.count(), 2);
  done.emit('close');
  assert.equal(started.count(), 1);
  started.stopAll();
  assert.deepEqual(running.killed, ['SIGTERM']);
  assert.deepEqual(done.killed, [], 'one that ended is not signalled');
  assert.equal(started.count(), 0);
  started.stopAll();
  assert.deepEqual(running.killed, ['SIGTERM'], 'nothing left to stop');
});

test('a browse that never ends by itself, still running when the app quits, is stopped (a real process)', async () => {
  // longer than the test: only the quit can end it
  const out = collect('/bin/sh', ['-c', 'echo browsing; exec sleep 60'], 120_000);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(started.count(), 1);
  started.stopAll();
  assert.equal(await out, 'browsing\n', 'what it printed before it was stopped');
  assert.equal(started.count(), 0);
});

test('disposing the machines service (the app quitting) stops what Host still runs', (t) => {
  installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'started-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const m = createMachines({
    dir,
    allowed: () => true,
    watch: () => undefined,
    call: async () => ({ harnesses: [], capabilities: {} }),
    onChange: () => undefined,
    onStep: () => undefined,
    installer: { install: async () => ({}) },
  });
  const browse = started.track(new Child());
  m.dispose();
  assert.deepEqual(browse.killed, ['SIGTERM']);
});
