// Edge cases of live Bash output polling (electron/harness/claude/liveOutput.cjs): overlapping polls, odd
// replies, stops for unknown tasks and empty messages. Timers and the query are faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const { createLiveOutput } = createRequire(import.meta.url)('../electron/harness/claude/liveOutput.cjs');
const started = (extra: object = {}) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: 'b1',
  tool_use_id: 'tu1',
  task_type: 'local_bash',
  ...extra,
});
function fakeTimers() {
  const live = new Set<() => void>();
  return {
    timers: { setInterval: (fn: () => void) => (live.add(fn), { fn }), clearInterval: (h: any) => void live.delete(h.fn) },
    fire: () => {
      for (const fn of [...live]) fn();
    },
    count: () => live.size,
  };
}

test('a poll still out is not repeated; a reply without output text is not forwarded', async () => {
  const t = fakeTimers();
  const pending: ((v: any) => void)[] = [];
  const sent: any[] = [];
  const live = createLiveOutput({
    q: { getTaskOutput: () => new Promise((r) => pending.push(r)) },
    emit: (m: any) => sent.push(m),
    timers: t.timers,
  });
  live.onMessage(started());
  t.fire();
  assert.equal(pending.length, 1);
  pending[0]({ output: 42 });
  await tick();
  pending.length = 0;
  t.fire();
  pending[0](null);
  await tick();
  assert.deepEqual(sent, []);
  assert.equal(live.watching(), 1);
  live.close();
});

test('a poll for a task that already stopped does nothing; stopping an unknown task is harmless', async () => {
  const t = fakeTimers();
  let calls = 0;
  const live = createLiveOutput({
    q: { getTaskOutput: async () => (calls++, { output: 'x' }) },
    emit: () => {},
    timers: t.timers,
    intervalMs: 5,
  });
  live.onMessage(null);
  live.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'nope' });
  live.onMessage({ type: 'system', subtype: 'task_updated', task_id: 'b1' });
  live.onMessage({ type: 'user', message: { content: 'text' } });
  live.onMessage(started());
  await tick();
  const polled = calls;
  t.fire();
  live.onMessage({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { is_backgrounded: true } });
  assert.equal(live.watching(), 0);
  assert.equal(t.count(), 0);
  await tick();
  assert.equal(calls, polled + 1);
});
