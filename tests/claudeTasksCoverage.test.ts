// Edge cases of Claude Code's background-task table (electron/harness/claude/tasks.cjs): partial SDK messages
// keep what is already known, and edges for unknown or ended tasks change nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { emptyTasks, reduceTasks, taskList, noteSchedule } = createRequire(import.meta.url)('../electron/harness/claude/tasks.cjs');
const sys = (subtype: string, extra: object = {}) => ({ type: 'system', subtype, ...extra });

test('a level without tasks or ids settles the table; partial entries keep known details', () => {
  const t = emptyTasks();
  reduceTasks(
    t,
    sys('task_started', {
      task_id: 'a',
      task_type: 'local_agent',
      description: 'Explore',
      subagent_type: 'Explore',
      is_backgrounded: true,
    }),
  );
  reduceTasks(t, sys('background_tasks_changed', { tasks: [null, {}, { task_id: 'a' }] }));
  const [a] = taskList(t);
  assert.deepEqual([a.type, a.description, a.subagentType, a.parentTaskId, a.ambient], ['local_agent', 'Explore', 'Explore', null, false]);
  assert.ok(reduceTasks(t, sys('background_tasks_changed')));
  assert.deepEqual(
    taskList(t).map((x: any) => [x.id, x.status, x.summary]),
    [['a', 'stopped', 'Ended in the background']],
  );
  assert.equal(t.level.size, 0);
});

test('the level brings an ended task back to running but leaves a paused one paused', () => {
  const t = emptyTasks();
  const level = sys('background_tasks_changed', { tasks: [{ task_id: 'p' }, { task_id: 'd' }] });
  reduceTasks(t, level);
  reduceTasks(t, sys('task_updated', { task_id: 'p', patch: { status: 'paused' } }));
  reduceTasks(t, sys('task_updated', { task_id: 'd', patch: { status: 'completed' } }));
  reduceTasks(t, level);
  assert.deepEqual(
    taskList(t).map((x: any) => [x.id, x.status]),
    [
      ['p', 'paused'],
      ['d', 'running'],
    ],
  );
});

test('task_started without details keeps them; a foreground task the level dropped is not revived', () => {
  const t = emptyTasks();
  reduceTasks(
    t,
    sys('task_started', {
      task_id: 'a',
      task_type: 'local_bash',
      description: 'npm test',
      tool_use_id: 'tu',
      workflow_name: 'wf',
      parent_task_id: 'root',
      ambient: true,
      is_backgrounded: true,
    }),
  );
  assert.ok(reduceTasks(t, sys('task_started', { task_id: 'a' })));
  const x = t.byId.get('a');
  assert.deepEqual(
    [x.type, x.description, x.toolUseId, x.workflowName, x.parentTaskId, x.ambient, x.backgrounded],
    ['local_bash', 'npm test', 'tu', 'wf', 'root', true, true],
  );
  reduceTasks(t, sys('background_tasks_changed', { tasks: [] }));
  assert.equal(reduceTasks(t, sys('task_started', { task_id: 'gone', is_backgrounded: false })), false);
  assert.ok(reduceTasks(t, sys('task_started', { task_id: 'late', is_backgrounded: true })));
});

test('task_progress fills in details, and is ignored for a task outside the level', () => {
  const t = emptyTasks();
  assert.ok(reduceTasks(t, sys('task_progress', { task_id: 'a', description: 'Build', tool_use_id: 'tu2', last_tool_name: 'Bash' })));
  const x = t.byId.get('a');
  assert.deepEqual([x.description, x.toolUseId, x.lastTool, x.summary], ['Build', 'tu2', 'Bash', null]);
  reduceTasks(t, sys('task_progress', { task_id: 'a' }));
  assert.equal(x.description, 'Build');
  reduceTasks(t, sys('background_tasks_changed', { tasks: [{ task_id: 'a' }] }));
  assert.equal(reduceTasks(t, sys('task_progress', { task_id: 'other', summary: 's' })), false);
  assert.ok(reduceTasks(t, sys('task_progress', { task_id: 'a', summary: 'half way' })));
  assert.equal(x.summary, 'half way');
});

test('task_updated and task_notification only touch known tasks; a level keeps the notified task', () => {
  const t = emptyTasks();
  assert.equal(reduceTasks(t, sys('task_updated', { task_id: 'x', patch: { status: 'killed' } })), false);
  assert.equal(reduceTasks(t, sys('task_notification', { task_id: 'x', status: 'completed' })), false);
  reduceTasks(t, sys('background_tasks_changed', { tasks: [{ task_id: 'a', description: 'old' }] }));
  assert.ok(reduceTasks(t, sys('task_updated', { task_id: 'a' })));
  reduceTasks(t, sys('task_updated', { task_id: 'a', patch: { description: 'new', is_backgrounded: false } }));
  const x = t.byId.get('a');
  assert.deepEqual([x.description, x.backgrounded, x.status], ['new', false, 'running']);
  reduceTasks(t, sys('task_notification', { task_id: 'a', status: 'failed' }));
  assert.deepEqual([x.status, x.summary, t.byId.has('a')], ['failed', null, true]);
});

test('an assistant message without content schedules nothing; other tools are ignored', () => {
  const sched = { crons: 0, wakeAt: 0 };
  noteSchedule(sched, { type: 'user', message: { content: [{ type: 'tool_use', name: 'CronCreate' }] } });
  noteSchedule(sched, { type: 'assistant' });
  noteSchedule(sched, {
    type: 'assistant',
    message: { content: [null, { type: 'text' }, { type: 'tool_use', name: 'Bash' }, { type: 'tool_use', name: 'CronDelete' }] },
  });
  assert.deepEqual(sched, { crons: 0, wakeAt: 0 });
  noteSchedule(
    sched,
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: 5 } }] } },
    1000,
  );
  // clamped to a minute, plus a minute's slack
  assert.equal(sched.wakeAt, 1000 + 120_000);
  noteSchedule(sched, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup' }] } }, 0);
  assert.equal(sched.wakeAt, 120_000);
  const before = Date.now();
  noteSchedule(sched, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: 60 } }] },
  });
  assert.ok(sched.wakeAt >= before + 120_000 && sched.wakeAt <= Date.now() + 120_000);
});
