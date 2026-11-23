// waitFor waits on the real clock: it outlasts slow async conditions, ignores mocked timers and names a timeout.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitFor } from './support/waitFor.ts';

test('a condition that holds at once resolves with its value without yielding', async () => {
  assert.equal(await waitFor(() => 7), 7);
});

test('a condition met by a file written well past twenty turns later still resolves, read by an awaited check', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wait-for-')), 'ready');
  setTimeout(() => fs.writeFileSync(file, 'yes'), 60);
  let checks = 0;
  const text = await waitFor(async () => {
    checks++;
    return fs.promises.readFile(file, 'utf8').catch(() => '');
  }, 'the file');
  assert.equal(text, 'yes');
  assert.ok(checks > 20, `checked past the quick turns (${checks})`);
});

test('mocked timers do not freeze the wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  let n = 0;
  assert.equal(await waitFor(() => ++n > 25 && n), 26);
  t.mock.timers.reset();
});

test('a step runs between checks, for a condition a fake clock is advanced toward', async () => {
  const steps = mock.fn();
  let clock = 0;
  await waitFor(() => clock >= 3, 'the clock', {
    step: () => {
      steps();
      clock++;
    },
  });
  assert.equal(steps.mock.callCount(), 3);
});

test('a condition that never holds fails after the timeout and names what it waited for', async () => {
  const started = performance.now();
  await assert.rejects(
    waitFor(() => false, 'the reply', { timeoutMs: 40 }),
    /Timed out after 40 ms waiting for the reply/,
  );
  assert.ok(performance.now() - started >= 40);
  await assert.rejects(
    waitFor(() => 0, undefined, { timeoutMs: 1 }),
    /waiting for the condition/,
  );
});
