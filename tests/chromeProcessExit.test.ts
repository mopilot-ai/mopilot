// Owned Chrome teardown distinguishes a close acknowledgement from process exit and bounds termination without deleting a live writer's profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { trackProcessExit, waitForProcessExit } from '../scripts/chrome-compare/processExit.mjs';

const child = () =>
  Object.assign(new EventEmitter(), {
    pid: 123 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: (_signal?: string) => {},
  });

test('exit receipts cover live, already exited, signalled and failed-to-spawn children without leftover listeners', async () => {
  for (const mode of ['live', 'code', 'signal', 'spawn-error', 'live-error']) {
    const c = child();
    if (mode === 'code') c.exitCode = 0;
    if (mode === 'signal') c.signalCode = 'SIGTERM';
    if (mode === 'spawn-error') c.pid = undefined;
    const stopped = trackProcessExit(c);
    let done = false;
    void stopped.then(() => {
      done = true;
    });
    if (mode === 'spawn-error' || mode === 'live-error') c.emit('error', new Error(mode));
    await new Promise((r) => setImmediate(r));
    assert.equal(done, ['code', 'signal', 'spawn-error'].includes(mode));
    if (!done) c.emit('exit', 0);
    await stopped;
    assert.equal(c.listenerCount('exit'), 0);
    assert.equal(c.listenerCount('error'), 0);
  }
});

test('bounded shutdown waits, terminates only its owned child, escalates and reports an unacknowledged exit', async () => {
  for (const mode of ['normal', 'term', 'kill', 'never']) {
    const c = child();
    const signals: (string | undefined)[] = [];
    const stopped = trackProcessExit(c);
    c.kill = (signal) => {
      signals.push(signal);
      if ((mode === 'term' && !signal) || (mode === 'kill' && signal === 'SIGKILL')) c.emit('exit', null, signal);
    };
    if (mode === 'normal') c.emit('exit', 0);
    const closing = waitForProcessExit(c, stopped, 1);
    if (mode === 'never') {
      await assert.rejects(closing, /profile is still in use/);
      c.emit('exit', 0);
    } else await closing;
    assert.deepEqual(signals, mode === 'normal' ? [] : mode === 'term' ? [undefined] : [undefined, 'SIGKILL']);
  }
});
