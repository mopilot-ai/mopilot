// Simulator launch diagnostics distinguish a process exit, failure and a bounded timeout without killing unrelated processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launchWithDeadline } from '../design/mobile-remote/spike/expo/simulatorLaunch.mjs';

test('records successful and failed launch command exits', async () => {
  for (const [code, status] of [
    [0, 'returned'],
    [2, 'failed'],
  ] as const) {
    const child = new EventEmitter();
    const result = launchWithDeadline(() => child as any, 1000);
    child.emit('exit', code, null);
    assert.equal((await result).status, status);
  }
});
test('times out and terminates only the supplied child', async () => {
  const child = new EventEmitter() as any;
  let signal = '';
  child.kill = (s: string) => {
    signal = s;
  };
  const result = await launchWithDeadline(() => child, 5);
  assert.equal(result.status, 'timeout');
  assert.equal(signal, 'SIGTERM');
});
test('reports launch process spawn errors', async () => {
  const child = new EventEmitter();
  const result = launchWithDeadline(() => child as any, 1000);
  child.emit('error', new Error('spawn failed'));
  assert.equal((await result).status, 'error');
});
