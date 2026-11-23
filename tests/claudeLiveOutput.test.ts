// Live output of a running Claude Bash command (D-68): electron/harness/claude/liveOutput.cjs polls getTaskOutput, and the translator
// puts what it reports on the command step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createLiveOutput } = require('../electron/harness/claude/liveOutput.cjs');
const { ClaudeTranslator } = await import('./support/claude-translate.ts');

const started = (extra: object = {}) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: 'b1',
  tool_use_id: 'tu1',
  task_type: 'local_bash',
  is_backgrounded: false,
  ...extra,
});

/** Fake timers: intervals run when the test says so. */
function fakeTimers() {
  const live = new Set<() => void>();
  return {
    timers: {
      setInterval: (fn: () => void) => {
        live.add(fn);
        return { fn, unref() {} } as any;
      },
      clearInterval: (h: any) => void live.delete(h.fn),
    },
    fire: async () => {
      for (const fn of [...live]) fn();
      await tick();
    },
    count: () => live.size,
  };
}

test('a foreground Bash task is polled, and only changed output is forwarded', async () => {
  const t = fakeTimers();
  const outs = ['a\n', 'a\n', 'a\nb\n'];
  const sent: any[] = [];
  const live = createLiveOutput({
    q: { getTaskOutput: async () => ({ output: outs.shift() ?? 'a\nb\n', total_bytes: 1, truncated: false }) },
    emit: (m: any) => sent.push(m),
    timers: t.timers,
  });
  live.onMessage(started());
  await tick();
  assert.deepEqual(
    sent.map((m) => m.output),
    ['a\n'],
  );
  await t.fire();
  assert.equal(sent.length, 1, 'same output again is not sent');
  await t.fire();
  assert.deepEqual(
    sent.map((m) => m.output),
    ['a\n', 'a\nb\n'],
  );
  assert.equal(sent[0].tool_use_id, 'tu1');
  assert.equal(sent[0].subtype, 'sage_bash_output');
  live.close();
  assert.equal(t.count(), 0);
});

test('the poll stops on the task notification and on the tool result', async () => {
  for (const end of [
    { type: 'system', subtype: 'task_notification', task_id: 'b1' },
    { type: 'user', message: { content: [null, 42, [], { type: 'tool_result', tool_use_id: 'tu1' }] } },
  ]) {
    const t = fakeTimers();
    const live = createLiveOutput({
      q: { getTaskOutput: async () => ({ output: 'x', total_bytes: 1, truncated: false }) },
      emit: () => {},
      timers: t.timers,
    });
    live.onMessage(started());
    assert.equal(live.watching(), 1);
    live.onMessage(end);
    assert.equal(live.watching(), 0);
    assert.equal(t.count(), 0);
  }
});

test('a reply that arrives after the task ended is dropped', async () => {
  const t = fakeTimers();
  let answer: (v: any) => void = () => {};
  const sent: any[] = [];
  const live = createLiveOutput({
    q: { getTaskOutput: () => new Promise((r) => (answer = r)) },
    emit: (m: any) => sent.push(m),
    timers: t.timers,
  });
  live.onMessage(started());
  live.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'b1' });
  answer({ output: 'late', total_bytes: 4, truncated: false });
  await tick();
  assert.equal(sent.length, 0);
});

test('background shells, other task types and a CLI without the request are left alone', () => {
  const t = fakeTimers();
  const live = createLiveOutput({ q: { getTaskOutput: async () => ({ output: 'x' }) }, emit: () => {}, timers: t.timers });
  live.onMessage(started({ is_backgrounded: true }));
  live.onMessage(started({ task_type: 'local_agent' }));
  live.onMessage(started({ tool_use_id: undefined }));
  assert.equal(live.watching(), 0);
  const none = createLiveOutput({ q: {}, emit: () => {}, timers: t.timers });
  none.onMessage(started());
  assert.equal(none.watching(), 0);
  assert.equal(none.disabled(), true);
});

test('a CLI that refuses the request is given up on after three failures', async () => {
  const t = fakeTimers();
  let calls = 0;
  const live = createLiveOutput({
    q: {
      getTaskOutput: async () => {
        calls++;
        throw new Error('unknown subtype');
      },
    },
    emit: () => {},
    timers: t.timers,
  });
  live.onMessage(started());
  await tick();
  await t.fire();
  await t.fire();
  assert.equal(calls, 3);
  assert.equal(live.watching(), 0);
  assert.equal(live.disabled(), true);
  live.onMessage(started({ task_id: 'b2', tool_use_id: 'tu2' }));
  assert.equal(live.watching(), 0, 'no more tasks are polled');
});

test('the command step shows the live output, and the result replaces it', () => {
  const events: any[] = [];
  const tr = new ClaudeTranslator('claude:x', '/repo', (method: string, params: any) => events.push({ method, params }));
  tr.beginTurn('ct-1', null);
  tr.onMessage({
    type: 'assistant',
    uuid: 'a1',
    message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] },
    parent_tool_use_id: null,
  });
  tr.onMessage({ type: 'system', subtype: 'sage_bash_output', tool_use_id: 'tu1', output: 'one\n', truncated: false });
  tr.onMessage({ type: 'system', subtype: 'sage_bash_output', tool_use_id: 'tu1', output: 'one\ntwo\n', truncated: true });
  const updates = events.filter((e) => e.method === 'item/updated').map((e) => e.params.item);
  assert.deepEqual(
    updates.map((i: any) => i.aggregatedOutput),
    ['one\n', '…\none\ntwo\n'],
  );
  assert.equal(updates[0].status, 'inProgress');
  tr.onMessage({
    type: 'user',
    uuid: 'r1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'one\ntwo\ndone' }] },
    tool_use_result: { stdout: 'one\ntwo\ndone', stderr: '' },
    parent_tool_use_id: null,
  });
  const done = events.filter((e) => e.method === 'item/completed').at(-1).params.item;
  assert.equal(done.aggregatedOutput, 'one\ntwo\ndone');
  assert.equal(done.status, 'completed');
  // output that arrives after the result changes nothing
  const n = events.length;
  tr.onMessage({ type: 'system', subtype: 'sage_bash_output', tool_use_id: 'tu1', output: 'late', truncated: false });
  assert.equal(events.length, n);
});

test('a retired task cannot disable live output with its late third failure', async () => {
  const t = fakeTimers();
  let fail!: (error: Error) => void;
  let calls = 0;
  const sent: any[] = [];
  const live = createLiveOutput({
    q: {
      getTaskOutput: async (id: string) => {
        if (id !== 'b1') return { output: 'new task' };
        if (++calls < 3) throw new Error('temporary failure');
        return new Promise((_, reject) => (fail = reject));
      },
    },
    emit: (m: any) => sent.push(m),
    timers: t.timers,
  });
  live.onMessage(started());
  await tick();
  await t.fire();
  await t.fire();
  live.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'b1' });
  fail(new Error('task already ended'));
  await tick();
  assert.equal(live.disabled(), false);
  live.onMessage(started({ task_id: 'b2', tool_use_id: 'tu2' }));
  await tick();
  assert.equal(sent.at(-1)?.output, 'new task');
  live.close();
  assert.equal(t.count(), 0);
});

test('a replaced watch ignores the old reply even when the task id is reused', async () => {
  for (const rejected of [false, true]) {
    const t = fakeTimers();
    let answer!: (value: any) => void;
    let fail!: (error: Error) => void;
    let calls = 0;
    const sent: any[] = [];
    const live = createLiveOutput({
      q: {
        getTaskOutput: () => {
          if (++calls === 1)
            return new Promise((resolve, reject) => {
              answer = resolve;
              fail = reject;
            });
          return Promise.resolve({ output: 'replacement' });
        },
      },
      emit: (m: any) => sent.push(m),
      timers: t.timers,
    });
    live.onMessage(started());
    live.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'b1' });
    live.onMessage(started({ tool_use_id: 'replacement-tool' }));
    await tick();
    if (rejected) fail(new Error('retired request'));
    else answer({ output: 'stale output' });
    await tick();
    assert.deepEqual(
      sent.map((m) => [m.tool_use_id, m.output]),
      [['replacement-tool', 'replacement']],
    );
    assert.equal(live.watching(), 1);
    assert.equal(live.disabled(), false);
    live.close();
  }
});

test('giving up on session polling retires every task and drops in-flight replies', async () => {
  const t = fakeTimers();
  let answer!: (value: any) => void;
  let calls = 0;
  const sent: any[] = [];
  const live = createLiveOutput({
    q: {
      getTaskOutput: async (id: string) => {
        calls++;
        if (id === 'b2') return new Promise((resolve) => (answer = resolve));
        throw new Error('unsupported output request');
      },
    },
    emit: (m: any) => sent.push(m),
    timers: t.timers,
  });
  live.onMessage(started());
  live.onMessage(started({ task_id: 'b2', tool_use_id: 'tu2' }));
  await tick();
  await t.fire();
  await t.fire();
  assert.equal(live.disabled(), true);
  assert.equal(live.watching(), 0);
  assert.equal(t.count(), 0);
  answer({ output: 'late sibling' });
  await tick();
  await t.fire();
  assert.deepEqual(sent, []);
  assert.equal(calls, 4);
});
