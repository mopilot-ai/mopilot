// Claude Code's own task lists as the turn's plan (core/crates/translate/src/claude): TodoWrite's whole list, and the
// tasks TaskCreate (named by its result) and TaskUpdate keep by id, live and read back from a transcript, with no rows
// of their own in the chat or a sub-agent's page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeTranslator, buildTurns } from './support/claude-translate.ts';
import { subagentItems } from './support/claude-translate.ts';

const use = (name: string, input?: any, id = name) => ({ type: 'tool_use', id, name, input });
const result = (tool_use_id: string, content: any, is_error = false) => ({ type: 'tool_result', tool_use_id, content, is_error });
const asst = (id: string, content: any[]) => ({ type: 'assistant', message: { id, content } });
const user = (content: any[], tool_use_result?: any) => ({ type: 'user', message: { content }, tool_use_result });

function live() {
  const events: [string, any][] = [];
  const tr = new ClaudeTranslator('t1', '/repo', (m: string, p: any) => events.push([m, p]));
  tr.beginTurn('turn');
  const plans = () => events.filter(([m]) => m === 'turn/plan/updated').map(([, p]) => p);
  const rows = () => events.filter(([m]) => m.startsWith('item/')).map(([, p]) => p.item.id);
  return { tr, plans, rows };
}

test('TaskCreate adds a task once its result names it; TaskUpdate sets its status and subject, or deletes it', () => {
  const { tr, plans, rows } = live();
  tr.onMessage(
    asst('m1', [use('TaskCreate', { subject: 'Read code', description: 'd' }, 'c1'), use('TaskCreate', { subject: 'Write tests' }, 'c2')]),
  );
  assert.deepEqual(plans(), [], 'a task shows once it has its id');
  // the structured result, then the text one the CLI writes
  tr.onMessage(user([result('c1', 'Task #1 created successfully: Read code')], { task: { id: '1', subject: 'Read code' } }));
  tr.onMessage(user([result('c2', [{ type: 'text', text: 'Task #2 created successfully: Write tests' }])]));
  tr.onMessage(asst('m2', [use('TaskUpdate', { taskId: '1', status: 'in_progress' }, 'u1')]));
  tr.onMessage(
    asst('m3', [
      use('TaskUpdate', { taskId: '1', status: 'completed' }, 'u2'),
      use('TaskUpdate', { taskId: 2, subject: 'Write UT', status: 'in_progress' }, 'u3'),
    ]),
  );
  tr.onMessage(asst('m4', [use('TaskUpdate', { taskId: '1', status: 'deleted' }, 'u4')]));
  assert.deepEqual(
    plans().map((p) => p.plan),
    [
      [{ step: 'Read code', status: 'pending' }],
      [
        { step: 'Read code', status: 'pending' },
        { step: 'Write tests', status: 'pending' },
      ],
      [
        { step: 'Read code', status: 'inProgress' },
        { step: 'Write tests', status: 'pending' },
      ],
      [
        { step: 'Read code', status: 'completed' },
        { step: 'Write tests', status: 'pending' },
      ],
      [
        { step: 'Read code', status: 'completed' },
        { step: 'Write UT', status: 'inProgress' },
      ],
      [{ step: 'Write UT', status: 'inProgress' }],
    ],
  );
  assert.ok(plans().every((p) => p.turnId === 'turn' && p.threadId === 't1' && p.explanation === null));
  // the task tools have no rows of their own
  assert.deepEqual(rows(), []);
});

test('a TaskCreate that fails or names no task adds none; an unknown task gets its id for a name; malformed input changes nothing', () => {
  const { tr, plans } = live();
  tr.onMessage(
    asst('m1', [use('TaskCreate', { subject: 'x' }, 'bad'), use('TaskCreate', {}, 'odd'), use('TaskCreate', undefined, 'named')]),
  );
  tr.onMessage(user([result('bad', 'Error: no', true), result('odd', 'created'), result('named', 'Task #7 created successfully')]));
  // a task from before the translator's first message (an older page of history)
  tr.onMessage(
    asst('m2', [
      use('TaskUpdate', { taskId: '9', status: 'bogus' }, 'u1'),
      use('TaskUpdate', { status: 'completed' }, 'u2'),
      use('TaskUpdate', undefined, 'u3'),
    ]),
  );
  // a result for a call that isn't a TaskCreate changes nothing
  tr.onMessage(user([result('u1', 'ok')]));
  assert.deepEqual(
    plans().map((p) => p.plan),
    [
      [{ step: 'Task 7', status: 'pending' }],
      [
        { step: 'Task 7', status: 'pending' },
        { step: 'Task 9', status: 'pending' },
      ],
    ],
  );
  // a TaskCreate the turn left without its result (an interrupt) names no task when a later turn begins
  tr.onMessage(asst('m3', [use('TaskCreate', { subject: 'Lost' }, 'lost')]));
  tr.beginTurn('next');
  tr.onMessage(user([result('lost', 'Task #8 created successfully: Lost')]));
  assert.equal(plans().length, 2);
});

test('read back, the turn has the task list it ended with; a sub-agent’s task tools have no rows on its page', () => {
  const turns = buildTurns(
    [
      { type: 'user', uuid: 'p1', message: { content: 'go' } },
      asst('m1', [use('TaskCreate', { subject: 'One' }, 'c1')]),
      user([result('c1', 'Task #1 created successfully: One')]),
      asst('m2', [use('TaskUpdate', { taskId: '1', status: 'completed' }, 'u1')]),
      user([result('u1', 'Updated task #1 status')]),
      asst('m3', [{ type: 'text', text: 'done' }]),
    ],
    't',
    '/r',
  );
  assert.deepEqual(turns[0].plan, { explanation: null, steps: [{ step: 'One', status: 'completed' }] });
  const sub = subagentItems(
    [
      asst('s1', [
        use('TaskCreate', { subject: 'x' }, 'c'),
        use('TaskUpdate', { taskId: '1' }, 'u'),
        use('TodoWrite', { todos: [] }, 't'),
        use('Bash', { command: 'ls' }, 'b'),
      ]),
    ],
    'chat',
    '/repo',
  );
  assert.deepEqual(
    sub.map((i: any) => i.type),
    ['commandExecution'],
  );
});
