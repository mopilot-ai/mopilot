// Claude Code's background-task table (electron/harness/claude/tasks.cjs): the level signal, the task_* edges
// and what keeps an idle process from being reaped. Messages follow the SDK's shapes (C8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { emptyTasks, reduceTasks, taskList, hasActivity, noteSchedule, keepAlive } = createRequire(import.meta.url)(
  '../electron/harness/claude/tasks.cjs',
);
const sys = (subtype: string, extra: object) => ({ type: 'system', subtype, uuid: 'x', session_id: 's', ...extra });

test('the level replaces the set; edges add details; a stopped task stays listed when the level drops it', () => {
  const t = emptyTasks();
  // in practice a background task joins the level before its task_started
  assert.ok(
    reduceTasks(
      t,
      sys('background_tasks_changed', { tasks: [{ task_id: 'a1', task_type: 'local_agent', description: 'Explore the repo' }] }),
    ),
  );
  reduceTasks(
    t,
    sys('task_started', {
      task_id: 'a1',
      tool_use_id: 'toolu_1',
      description: 'Explore the repo',
      task_type: 'local_agent',
      is_backgrounded: true,
    }),
  );
  reduceTasks(t, sys('task_progress', { task_id: 'a1', description: 'Explore the repo', usage: {}, summary: 'Reading the auth module' }));
  assert.deepEqual(
    taskList(t).map((x: any) => [x.id, x.type, x.summary, x.toolUseId]),
    [['a1', 'local_agent', 'Reading the auth module', 'toolu_1']],
  );
  assert.ok(hasActivity(t));
  // stopped: task_updated, task_notification, then the level without it
  reduceTasks(t, sys('task_updated', { task_id: 'a1', patch: { status: 'killed' } }));
  assert.deepEqual(
    taskList(t).map((x: any) => x.status),
    ['stopped'],
  );
  assert.equal(hasActivity(t), false);
  reduceTasks(t, sys('task_notification', { task_id: 'a1', status: 'stopped', output_file: '', summary: 'stopped' }));
  reduceTasks(t, sys('background_tasks_changed', { tasks: [] }));
  assert.deepEqual(
    taskList(t).map((x: any) => [x.id, x.status, x.summary, x.agentKey]),
    [['a1', 'stopped', 'stopped', 'toolu_1']],
  );
  assert.equal(hasActivity(t), false);
});

test('foreground agents are not background tasks; ambient ones are listed but are not activity', () => {
  const t = emptyTasks();
  reduceTasks(
    t,
    sys('background_tasks_changed', { tasks: [{ task_id: 'w1', task_type: 'monitor', description: 'watch', ambient: true }] }),
  );
  reduceTasks(t, sys('task_started', { task_id: 'f1', description: 'inline helper', task_type: 'local_agent', is_backgrounded: false }));
  assert.deepEqual(
    taskList(t).map((x: any) => x.id),
    ['w1'],
  );
  assert.equal(hasActivity(t), false);
});

test('a CLI that never sends the level still settles a task on its notification', () => {
  const t = emptyTasks();
  reduceTasks(t, sys('task_started', { task_id: 'b1', description: 'sleep 30', task_type: 'local_bash', is_backgrounded: true }));
  assert.deepEqual(
    taskList(t).map((x: any) => x.id),
    ['b1'],
  );
  reduceTasks(t, sys('task_notification', { task_id: 'b1', status: 'completed', output_file: '', summary: 'done' }));
  assert.deepEqual(
    taskList(t).map((x: any) => [x.id, x.status]),
    [['b1', 'completed']],
  );
  assert.equal(hasActivity(t), false);
  assert.equal(reduceTasks(t, { type: 'assistant' }), false);
});

test('cron jobs and a pending /loop wake-up keep the process; tasks do too', () => {
  const sched = { crons: 0, wakeAt: 0 };
  const call = (name: string, input: object = {}) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't', name, input }] },
  });
  const now = 1_000_000;
  assert.equal(keepAlive(emptyTasks(), sched, now), false);
  noteSchedule(sched, call('CronCreate', { cron: '*/5 * * * *', prompt: 'check' }), now);
  assert.ok(keepAlive(emptyTasks(), sched, now));
  noteSchedule(sched, call('CronDelete', { id: 'j1' }), now);
  assert.equal(keepAlive(emptyTasks(), sched, now), false);
  noteSchedule(sched, call('ScheduleWakeup', { delaySeconds: 600, prompt: '/loop x' }), now);
  assert.ok(keepAlive(emptyTasks(), sched, now + 600_000));
  assert.equal(keepAlive(emptyTasks(), sched, now + 700_000), false);
  noteSchedule(sched, call('ScheduleWakeup', { stop: true }), now);
  assert.equal(sched.wakeAt, 0);
  const t = emptyTasks();
  reduceTasks(t, sys('background_tasks_changed', { tasks: [{ task_id: 'r1', task_type: 'local_agent', description: 'code review' }] }));
  assert.ok(keepAlive(t, sched, now));
});

test('invalid assistant content cannot abort schedule tracking or create a wakeup', () => {
  const sched = { crons: 0, wakeAt: 0 };
  for (const content of [{ type: 'tool_use', name: 'CronCreate' }, 42, 'not blocks', [null, 42, []]]) {
    noteSchedule(sched, { type: 'assistant', message: { content } }, 100);
    assert.deepEqual(sched, { crons: 0, wakeAt: 0 });
  }
  noteSchedule(sched, { type: 'assistant', message: { content: [null, { type: 'tool_use', name: 'CronCreate' }] } }, 100);
  assert.equal(sched.crons, 1);
});
