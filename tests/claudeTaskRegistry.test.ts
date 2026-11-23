// Claude Code's task registry (electron/harness/claude/tasks.cjs): finished tasks stay listed with how they ended, statuses
// normalize, the level and the process's end settle what still ran, shells keep their command and output file, and
// only running tasks count as activity (main's exit gate, the composer's task panel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isRunningTask, taskSections } from '../src/lib/tasks.ts';

const require = createRequire(import.meta.url);
const tasks = require('../electron/harness/claude/tasks.cjs');
const { emptyTasks, reduceTasks, taskList, runningTasks, hasActivity, keepAlive, settleAll, mergeTaskLists, settleTaskList } = tasks;
const { claudeBackground } = require('../electron/platform/exitGate.cjs');
const sys = (subtype: string, extra: object = {}) => ({ type: 'system', subtype, ...extra });
const level = (...ids: (string | object)[]) =>
  sys('background_tasks_changed', {
    tasks: ids.map((x) => (typeof x === 'string' ? { task_id: x, task_type: 'local_agent', description: x } : x)),
  });
const sched = { crons: 0, wakeAt: 0 };

test('a finished task keeps its timing, usage, latest tool and agent key; it is not activity', () => {
  const t = emptyTasks();
  reduceTasks(t, level('a1'), 1000);
  reduceTasks(
    t,
    sys('task_started', { task_id: 'a1', tool_use_id: 'toolu_a', task_type: 'local_agent', is_backgrounded: true, run_id: 'r1' }),
    1100,
  );
  reduceTasks(t, sys('task_progress', { task_id: 'a1', usage: { total_tokens: 40, tool_uses: 3 }, last_tool_name: 'Read' }));
  reduceTasks(t, sys('task_progress', { task_id: 'a1', usage: { total_tokens: 'n/a' } }));
  assert.ok(hasActivity(t) && keepAlive(t, sched));
  reduceTasks(
    t,
    sys('task_notification', {
      task_id: 'a1',
      status: 'completed',
      summary: 'Found it',
      usage: { total_tokens: 90, tool_uses: 7 },
      output_file: '/x/tasks/a1.output',
    }),
    5000,
  );
  const [a] = taskList(t);
  assert.deepEqual(
    [a.status, a.startedAt, a.completedAt, a.tokens, a.toolUses, a.latestTool, a.agentKey, a.summary, a.output, a.model],
    ['completed', 1000, 5000, 90, 7, 'Read', 'toolu_a', 'Found it', null, null],
  );
  assert.equal(hasActivity(t), false);
  assert.equal(keepAlive(t, sched), false);
  assert.deepEqual(runningTasks(t), []);
  // a level that still lists it doesn't bring it back; a new run of it (a resumed agent) does
  reduceTasks(t, level({ task_id: 'a1', run_id: 'r1' }), 6000);
  assert.equal(taskList(t)[0].status, 'completed');
  reduceTasks(t, level('a1'), 6000);
  assert.equal(taskList(t)[0].status, 'completed');
  reduceTasks(t, level({ task_id: 'a1', run_id: 'r2' }), 7000);
  assert.deepEqual([taskList(t)[0].status, taskList(t)[0].completedAt], ['running', null]);
  // and leaving the level without a word, it ended in the background
  reduceTasks(t, level(), 8000);
  assert.deepEqual([taskList(t)[0].status, taskList(t)[0].completedAt, taskList(t)[0].summary], ['stopped', 8000, 'Found it']);
});

test('statuses normalize: killed is stopped, blocked and cancelled failed, unknown completed', () => {
  const t = emptyTasks();
  reduceTasks(t, level('k', 'b', 'c', 'u', 'p'));
  reduceTasks(t, sys('task_updated', { task_id: 'k', patch: { status: 'killed' } }), 10);
  reduceTasks(t, sys('task_notification', { task_id: 'b', status: 'blocked' }));
  reduceTasks(t, sys('task_notification', { task_id: 'c', status: 'cancelled' }));
  reduceTasks(t, sys('task_notification', { task_id: 'u', status: 'mystery' }));
  reduceTasks(t, sys('task_notification', { task_id: 'p' }));
  assert.deepEqual(
    taskList(t).map((x: any) => [x.id, x.status]),
    [
      ['k', 'stopped'],
      ['b', 'failed'],
      ['c', 'failed'],
      ['u', 'completed'],
      ['p', 'completed'],
    ],
  );
  assert.equal(taskList(t)[0].completedAt, 10);
  // a settled status patched back to running is running again
  reduceTasks(t, sys('task_updated', { task_id: 'k', patch: { status: 'pending' } }));
  assert.deepEqual([taskList(t)[0].status, taskList(t)[0].completedAt], ['pending', null]);
  reduceTasks(t, sys('task_updated', { task_id: 'k', patch: { status: 'error' } }));
  assert.equal(taskList(t)[0].status, 'failed');
  for (const s of ['running', 'pending', 'paused', null, undefined]) assert.equal(tasks.settledStatus(s), null);
});

test('a task gone from the level: a background one settles as stopped, a foreground one is forgotten', () => {
  const t = emptyTasks();
  reduceTasks(t, sys('task_started', { task_id: 'bg', is_backgrounded: true, description: 'sleep' }));
  reduceTasks(t, sys('task_started', { task_id: 'fg', is_backgrounded: false }));
  reduceTasks(t, sys('task_started', { task_id: 'nb' }));
  // before any level, a foreground task is known but not listed
  assert.deepEqual(
    taskList(t).map((x: any) => x.id),
    ['bg', 'nb'],
  );
  reduceTasks(t, level(), 50);
  assert.deepEqual(
    taskList(t).map((x: any) => [x.id, x.status, x.summary]),
    [['bg', 'stopped', 'Ended in the background']],
  );
  assert.ok(!t.byId.has('fg') && !t.byId.has('nb'));
  // a foreground task that finished is not listed or kept
  const u = emptyTasks();
  reduceTasks(u, sys('task_started', { task_id: 'f', is_backgrounded: false }));
  reduceTasks(u, sys('task_notification', { task_id: 'f', status: 'completed' }));
  assert.equal(u.byId.size, 0);
});

test('the newest 100 finished tasks stay listed', () => {
  const t = emptyTasks();
  for (let i = 0; i < 103; i++) {
    reduceTasks(t, sys('task_started', { task_id: `t${i}`, is_backgrounded: true }));
    reduceTasks(t, sys('task_notification', { task_id: `t${i}`, status: 'completed' }), 1000 + i);
  }
  reduceTasks(t, sys('task_started', { task_id: 'live', is_backgrounded: true }));
  const list = taskList(t);
  assert.equal(list.length, tasks.FINISHED_MAX + 1);
  assert.equal(list[0].id, 't3');
});

test('a background shell keeps its command and output file, from its Bash call or its notification', () => {
  const t = emptyTasks();
  const call = (id: string, command: string, extra: object = {}) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command, run_in_background: true, ...extra } }] },
  });
  const ran = (id: string, text: any) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  });
  assert.equal(reduceTasks(t, call('tu1', 'npm run dev')), false);
  // the task is known before its result: the result fills it in
  reduceTasks(t, sys('task_started', { task_id: 'b1', task_type: 'local_bash', tool_use_id: 'tu1', is_backgrounded: true }));
  assert.equal(taskList(t)[0].command, 'npm run dev');
  assert.ok(reduceTasks(t, ran('tu1', 'Command running in background with ID: b1. Output is being written to: /tmp/x/tasks/b1.output')));
  assert.deepEqual(taskList(t)[0].output, { kind: 'file', path: '/tmp/x/tasks/b1.output' });
  // the result before the task: the task takes it when it appears
  reduceTasks(t, call('tu2', 'make'));
  assert.equal(
    reduceTasks(
      t,
      ran('tu2', [
        null,
        { type: 'image' },
        { type: 'text', text: 'Command running in background with ID: b2\nOutput is being written to: /tmp/x/tasks/b2.output' },
      ]),
    ),
    false,
  );
  reduceTasks(t, level({ task_id: 'b1', task_type: 'local_bash' }, { task_id: 'b2', task_type: 'local_bash', description: 'make' }));
  const b2 = taskList(t).find((x: any) => x.id === 'b2');
  assert.deepEqual([b2.command, b2.toolUseId, b2.output?.path, b2.agentKey], ['make', 'tu2', '/tmp/x/tasks/b2.output', null]);
  // a path that isn't the task's own output file is not kept
  reduceTasks(t, ran('tu9', 'Command running in background with ID: b3. Output is being written to: /etc/tasks/other.output'));
  reduceTasks(t, sys('task_started', { task_id: 'b3', task_type: 'local_bash', is_backgrounded: true }));
  reduceTasks(t, level({ task_id: 'b1' }, { task_id: 'b2' }, { task_id: 'b3', task_type: 'local_bash' }));
  assert.equal(taskList(t).find((x: any) => x.id === 'b3').output, null);
  // the notification's output file, for a task that had none
  reduceTasks(t, sys('task_notification', { task_id: 'b3', status: 'completed', output_file: '/t/tasks/b3.output' }));
  assert.deepEqual(taskList(t).find((x: any) => x.id === 'b3').output, { kind: 'file', path: '/t/tasks/b3.output' });
  // nothing to note: other tools, other results, messages without content
  assert.equal(
    reduceTasks(t, {
      type: 'assistant',
      message: { content: [null, { type: 'tool_use', name: 'Bash', input: {} }, { type: 'tool_use', name: 'Read' }] },
    }),
    false,
  );
  assert.equal(reduceTasks(t, ran('x', 'plain')), false);
  assert.equal(reduceTasks(t, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'y' }] } }), false);
  assert.equal(reduceTasks(t, { type: 'user', message: { content: 'text' } }), false);
  assert.equal(reduceTasks(t, { type: 'user' }), false);
  // the call ids kept are bounded
  for (let i = 0; i < 205; i++) {
    reduceTasks(t, call(`c${i}`, 'x'));
    reduceTasks(t, ran(`c${i}`, `Command running in background with ID: s${i}. Output is being written to: /t/tasks/s${i}.output`));
  }
  assert.equal(t.commands.size, 200);
  assert.equal(t.shells.size, 200);
});

test('output files are only read for the task they belong to, and only their tail', async () => {
  const { isTaskOutput, readTaskOutput } = tasks;
  assert.ok(isTaskOutput('b1', '/tmp/x/tasks/b1.output'));
  assert.ok(isTaskOutput('b1', 'C:\\Users\\me\\tasks\\b1.output'));
  for (const [id, p] of [
    ['b1', '/tmp/x/tasks/b2.output'],
    ['b1', 'tasks/b1.output'],
    ['b1', '/tmp/../tasks/b1.output'],
    ['b1', '/tmp/x/b1.output'],
    ['../b1', '/tmp/tasks/../b1.output'],
    ['b1', 7],
    [7, '/tmp/tasks/7.output'],
  ])
    assert.equal(isTaskOutput(id, p), false, String(p));
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sage-task-out-')), 'tasks');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'b1.output');
  fs.writeFileSync(file, 'head\n' + 'x'.repeat(10) + '\ntail');
  assert.equal(await readTaskOutput('b1', file), 'head\n' + 'x'.repeat(10) + '\ntail');
  assert.equal(await readTaskOutput('b1', file, 4), 'tail');
  await assert.rejects(readTaskOutput('b2', file), /Not a task output file/);
  await assert.rejects(readTaskOutput('b9', path.join(dir, 'b9.output')), /ENOENT/);
});

test('output read failures survive a second failure while closing the file', async (t) => {
  const primary = new Error('read failed');
  const cleanup = new Error('close failed');
  let stage = 'stat';
  let closes = 0;
  t.mock.method(fs.promises, 'open', async () => ({
    stat: async () => {
      if (stage === 'stat') throw primary;
      return { size: 1 };
    },
    read: async () => {
      if (stage === 'read') throw primary;
    },
    close: async () => {
      closes++;
      throw cleanup;
    },
  }));
  for (stage of ['stat', 'read']) await assert.rejects(tasks.readTaskOutput('b1', '/tmp/tasks/b1.output'), (e) => e === primary);
  stage = 'success';
  await assert.rejects(tasks.readTaskOutput('b1', '/tmp/tasks/b1.output'), (e) => e === cleanup);
  assert.equal(closes, 3);
});

test("the process's end settles what still ran; a session's list keeps finished tasks across processes", () => {
  const t = emptyTasks();
  reduceTasks(t, level('a', 'b'));
  reduceTasks(t, sys('task_notification', { task_id: 'b', status: 'failed' }));
  assert.equal(settleAll(t, 99), true);
  assert.deepEqual(
    taskList(t).map((x: any) => [x.id, x.status, x.completedAt, x.summary]),
    [
      ['a', 'stopped', 99, 'Ended when the Claude Code process exited'],
      ['b', 'failed', taskList(t)[1].completedAt, null],
    ],
  );
  assert.equal(settleAll(t), false);
  const run = (id: string, extra: object = {}) => ({ id, status: 'running', summary: null, completedAt: null, ...extra });
  const prev = [run('old'), run('done', { status: 'completed', completedAt: 5, summary: 's' }), run('same')];
  const merged = mergeTaskLists(prev, [run('same', { summary: 'new' }), run('fresh')], 7);
  assert.deepEqual(
    merged.map((x: any) => [x.id, x.status, x.completedAt, x.summary]),
    [
      ['same', 'running', null, 'new'],
      ['fresh', 'running', null, null],
      ['old', 'stopped', 7, 'Ended when the Claude Code process exited'],
      ['done', 'completed', 5, 's'],
    ],
  );
  assert.deepEqual(mergeTaskLists(undefined, [run('x')]).length, 1);
  assert.deepEqual(
    settleTaskList([run('r', { completedAt: 3, summary: 'kept' })]).map((x: any) => [x.status, x.completedAt, x.summary]),
    [['stopped', 3, 'kept']],
  );
  const many = Array.from({ length: 105 }, (_, i) => run(`f${i}`, { status: 'completed', completedAt: i }));
  const capped = mergeTaskLists([], [...many, run('live'), run('nodate', { status: 'stopped' })]);
  assert.equal(capped.length, 101);
  assert.ok(capped.some((x: any) => x.id === 'live') && !capped.some((x: any) => x.id === 'nodate' || x.id === 'f4'));
});

test('only running tasks count: the exit gate and the task panel', () => {
  const list = [
    { id: 'r', type: 'local_bash', ambient: false, status: 'running', description: 'r', summary: null, parentTaskId: null },
    { id: 'd', type: 'local_bash', ambient: false, status: 'completed', description: 'd', summary: null, parentTaskId: null },
    { id: 's', type: 'monitor', ambient: true, status: 'stopped', description: 's', summary: null, parentTaskId: null },
  ];
  assert.equal(claudeBackground(list), 1);
  assert.deepEqual(
    taskSections(list as any).running.map((n) => n.task.id),
    ['r'],
  );
  assert.deepEqual(
    ['running', 'pending', 'completed', 'failed', 'stopped'].map((status) => isRunningTask({ status })),
    [true, true, false, false, false],
  );
});
