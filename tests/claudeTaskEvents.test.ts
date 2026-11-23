// Claude background task events in the Claude translator (core/crates/translate/src/claude): the running card a background start gets, and the settled
// events notifications become, each carrying the tool call that started its task so the transcript shows it once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asst, mk, res, use } from './support/claude-translator-kit.ts';

test('task events: the kind from what was launched, a title from the summary, no id, once per status', () => {
  const { tr, items } = mk();
  tr.beginTurn('t');
  tr.onMessage(asst([use('Bash', { command: 'npm run dev', run_in_background: true }, 'sh'), use('Bash', { command: 'make' }, 'sh2')]));
  tr.onMessage(res('sh', 'Command running in background with ID: b1. Output is being written to: /t/tasks/b1.output'));
  tr.onMessage(res('sh2', 'Command running in background with ID: b2. Output is being written to: /t/tasks/b2.output'));
  tr.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'sh', status: 'failed', summary: '' });
  const user = (xml: string, uuid?: string) => tr.onMessage({ type: 'user', uuid, message: { content: xml } });
  user(
    '<task-notification><task-id>b2</task-id><tool-use-id>sh2</tool-use-id><status>completed</status><summary>Background command "make" completed</summary></task-notification>',
    'x',
  );
  user('<task-notification><task-id>b2</task-id><status>completed</status></task-notification>', 'dup');
  user('<task-notification><summary>Agent finished</summary></task-notification>', 'y');
  user('<task-notification></task-notification>', 'z');
  user('<task-notification></task-notification>', 'z2');
  assert.deepEqual(
    items('item/completed')
      .filter((i) => i.type === 'statusNote')
      .map((i) => [i.id, i.text, i.task]),
    [
      [
        'task-b1-failed',
        'Background task failed',
        { taskId: 'b1', kind: 'shell', title: 'Background task', status: 'failed', durationMs: null, toolUseId: 'sh' },
      ],
      [
        'x',
        'Background command "make" completed',
        { taskId: 'b2', kind: 'shell', title: 'make', status: 'completed', durationMs: null, toolUseId: 'sh2' },
      ],
      [
        'y',
        'Agent finished',
        { taskId: '', kind: 'agent', title: 'Agent finished', status: 'completed', durationMs: null, toolUseId: null },
      ],
      [
        'z',
        'Background task update',
        { taskId: '', kind: 'task', title: 'Background task', status: 'completed', durationMs: null, toolUseId: null },
      ],
      [
        'z2',
        'Background task update',
        { taskId: '', kind: 'task', title: 'Background task', status: 'completed', durationMs: null, toolUseId: null },
      ],
    ],
  );
  // between turns a task event waits for the turn Claude starts for it
  tr.endTurn('completed', null);
  tr.onMessage({
    type: 'user',
    message: { content: '<task-notification><task-id>q</task-id><status>stopped</status></task-notification>' },
  });
  tr.onMessage({
    type: 'user',
    message: { content: '<task-notification><task-id>q</task-id><status>stopped</status></task-notification>' },
  });
  assert.equal(items('item/completed').filter((i) => i.task?.taskId === 'q').length, 0);
  tr.onMessage(asst([{ type: 'text', text: 'It stopped.' }], { id: 'm9' }));
  assert.equal(items('item/completed').filter((i) => i.task?.taskId === 'q').length, 1);
});

test('a command, monitor or workflow started in the background gets a running card; the rest stay quiet', () => {
  const { tr, items, events } = mk();
  tr.beginTurn('t');
  const start = (extra: any) =>
    tr.onMessage({ type: 'system', subtype: 'task_started', task_id: 'b1', is_backgrounded: true, description: 'npm run dev', ...extra });
  const notes = () => items('item/completed').filter((i) => i.type === 'statusNote');
  // foreground, an agent, and a start without an id make no card
  start({ task_type: 'local_bash', is_backgrounded: false });
  start({ task_type: 'local_agent' });
  start({ task_type: 'local_bash', task_id: '' });
  assert.equal(notes().length, 0);
  start({ task_type: 'local_bash', tool_use_id: 'tu-b1' });
  start({ task_id: 'm1', task_type: 'monitor_mcp', description: '  ' });
  start({ task_id: 'w1', task_type: 'local_workflow' });
  start({ task_id: 'x1', task_type: undefined });
  assert.deepEqual(
    notes().map((n) => [n.id, n.task.kind, n.task.title, n.task.status, n.task.toolUseId]),
    // the call that started a task rides on its event, so its step row can stand for it
    [
      ['task-b1-running', 'shell', 'npm run dev', 'running', 'tu-b1'],
      ['task-m1-running', 'monitor', 'Background task', 'running', null],
      ['task-w1-running', 'workflow', 'npm run dev', 'running', null],
      ['task-x1-running', 'task', 'npm run dev', 'running', null],
    ],
  );
  // the turn ends; the task settles in the one a wake-up opens, but its card is updated where it stands
  tr.onMessage({ type: 'result', subtype: 'success', usage: {} });
  const before = items('item/completed').length;
  tr.onMessage({
    type: 'user',
    uuid: 'n1',
    message: {
      content:
        '<task-notification><task-id>b1</task-id><status>completed</status><summary>Background command "npm run dev" completed</summary></task-notification>',
    },
  });
  const settled = events.filter(([m]) => m === 'item/completed').slice(before);
  assert.deepEqual(
    settled.map(([, p]) => [p.turnId, p.item.id, p.item.task.status]),
    [['t', 'task-b1-running', 'completed']],
  );
  // the same settle again changes nothing
  const after = events.length;
  tr.onMessage({
    type: 'user',
    uuid: 'n2',
    message: { content: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>' },
  });
  assert.equal(events.length, after);
});
