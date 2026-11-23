// A Codex chat's background tasks (src/harness/codexTasks.ts): shells from the terminal list settle when they
// leave it, agents settle with their collab status, a failed list read settles nothing, Finished keeps the newest.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module('../src/harness/adapters/codexApi.ts', { namedExports: { codexApi: {} } });
const C = await import('../src/harness/codexTasks.ts');

const term = (processId: string, extra: any = {}) => ({
  itemId: `item-${processId}`,
  processId,
  command: `run ${processId}`,
  cwd: '/w',
  osPid: null,
  ...extra,
});
const spawn = (child: string, status: string, extra: any = {}) => ({
  type: 'collabAgentToolCall',
  id: `call-${child}`,
  tool: 'spawnAgent',
  status: 'completed',
  receiverThreadIds: [child],
  prompt: `Agent ${child}`,
  model: 'gpt-x',
  agentsStates: { [child]: { status, message: null } },
  ...extra,
});
const input = (over: any = {}) => ({
  turns: [],
  terminals: [],
  prev: [],
  stopped: new Set<string>(),
  child: () => ({}),
  now: 1000,
  ...over,
});

test('shells: a listed command is a running, stoppable task timed from its item', () => {
  const turns = [{ items: [], itemTimes: { 'item-p1': { start: 500 } } }, { items: [] }];
  const { tasks, settled } = C.buildCodexTasks(input({ turns, terminals: [term('p1'), term('p2', { itemId: '', command: '' })] }));
  assert.equal(settled.length, 0);
  const [a, b] = tasks;
  assert.equal(a.id, 'codex-shell:p1');
  assert.equal(a.type, 'local_bash');
  assert.equal(a.description, 'run p1');
  assert.equal(a.command, 'run p1');
  assert.equal(a.startedAt, 500);
  assert.deepEqual(a.output, { kind: 'process', id: 'item-p1' });
  assert.equal(a.stoppable, true);
  assert.equal(a.toolUseId, 'item-p1');
  assert.equal(b.description, 'Background command');
  assert.equal(b.startedAt, 1000);
  assert.equal(b.output, null);
  assert.equal(b.toolUseId, null);
  // the next poll keeps the first start
  const again = C.buildCodexTasks(input({ terminals: [term('p2')], prev: tasks, now: 2000 }));
  assert.equal(again.tasks.find((t) => t.id === 'codex-shell:p2')!.startedAt, 1000);
});

test('shells: one gone from the list settles as completed, or stopped when the user stopped it', () => {
  const prev = C.buildCodexTasks(input({ terminals: [term('a'), term('b')] })).tasks;
  const { tasks, settled } = C.buildCodexTasks(input({ terminals: [], prev, stopped: new Set(['codex-shell:b']), now: 4000 }));
  assert.deepEqual(
    settled.map((t) => [t.id, t.status, t.completedAt, t.stoppable]),
    [
      ['codex-shell:a', 'completed', 4000, false],
      ['codex-shell:b', 'stopped', 4000, false],
    ],
  );
  assert.equal(tasks.length, 2);
  // settled ones stay as they are on later polls, without another event
  const later = C.buildCodexTasks(input({ terminals: [], prev: tasks, now: 9000 }));
  assert.equal(later.settled.length, 0);
  assert.equal(later.tasks[0].completedAt, 4000);
});

test('shells: a non-zero exit code on the command item makes the task failed, even when it arrives after the shell left the list', () => {
  const cmd = (id: string, exitCode: unknown) => ({ type: 'commandExecution', id, exitCode });
  const prev = C.buildCodexTasks(input({ terminals: [term('a'), term('b'), term('c')] })).tasks;
  const turns = [{ items: [cmd('item-a', 3), cmd('item-b', 0), { type: 'agentMessage', id: 'item-c' }] }];
  const first = C.buildCodexTasks(input({ turns, terminals: [], prev, now: 4000 }));
  assert.deepEqual(
    first.settled.map((t) => [t.id, t.status]),
    [
      ['codex-shell:a', 'failed'],
      ['codex-shell:b', 'completed'],
      ['codex-shell:c', 'completed'],
    ],
  );
  // it ended with no code yet, and the code arrives on a later poll: the finished task is corrected, with no second card
  const early = C.buildCodexTasks(input({ turns: [{ items: [cmd('item-b', null)] }], terminals: [], prev, now: 4000 }));
  assert.equal(early.tasks.find((t) => t.id === 'codex-shell:b')!.status, 'completed');
  const late = C.buildCodexTasks(input({ turns: [{ items: [cmd('item-b', 2)] }], terminals: [], prev: early.tasks, now: 9000 }));
  assert.deepEqual([late.tasks.find((t) => t.id === 'codex-shell:b')!.status, late.settled.length], ['failed', 0]);
});

test('shells: a list that could not be read settles nothing', () => {
  const prev = C.buildCodexTasks(input({ terminals: [term('a')] })).tasks;
  const { tasks, settled } = C.buildCodexTasks(input({ terminals: null, prev }));
  assert.equal(settled.length, 0);
  assert.equal(tasks[0].status, 'running');
});

test('agents: spawned agents are listed with their run, settle once, and can be stopped only while they run', () => {
  const child = (key: string) =>
    key === 'c1'
      ? {
          thread: { agentNickname: 'Euler' },
          turns: [{ items: [{ type: 'commandExecution', id: 'x', command: 'ls', status: 'inProgress' }] }],
        }
      : {};
  const turns = [
    {
      items: [{ type: 'userMessage', id: 'u' }, spawn('c1', 'running'), spawn('c2', 'completed')],
      itemTimes: { 'call-c1': { start: 700 } },
    },
  ];
  const first = C.buildCodexTasks(input({ turns, child }));
  const a = first.tasks.find((t) => t.id === 'codex-agent:c1')!;
  assert.equal(a.type, 'local_agent');
  assert.equal(a.description, 'Euler');
  assert.equal(a.status, 'running');
  assert.equal(a.agentKey, 'c1');
  assert.equal(a.model, 'gpt-x');
  assert.equal(a.latestTool, 'Running ls');
  assert.equal(a.summary, 'Running ls');
  assert.equal(a.toolUses, 1);
  assert.equal(a.startedAt, 700);
  assert.equal(a.completedAt, null);
  assert.equal(a.stoppable, true);
  // already finished when first seen (history): listed, no event, no made-up end time
  const b = first.tasks.find((t) => t.id === 'codex-agent:c2')!;
  assert.equal(b.status, 'completed');
  assert.equal(b.completedAt, null);
  assert.equal(b.stoppable, false);
  assert.equal(b.startedAt, 1000);
  assert.equal(first.settled.length, 0);

  const doneTurns = [{ items: [spawn('c1', 'interrupted'), spawn('c2', 'completed')] }];
  const second = C.buildCodexTasks(input({ turns: doneTurns, prev: first.tasks, now: 5000 }));
  assert.deepEqual(
    second.settled.map((t) => [t.id, t.status, t.completedAt, t.startedAt]),
    [['codex-agent:c1', 'stopped', 5000, 700]],
  );
  const third = C.buildCodexTasks(input({ turns: doneTurns, prev: second.tasks, now: 8000 }));
  assert.equal(third.settled.length, 0);
  assert.equal(third.tasks.find((t) => t.id === 'codex-agent:c1')!.completedAt, 5000);
  // the spawn's turn unloaded: the agent stays as it was
  const fourth = C.buildCodexTasks(input({ turns: [], prev: third.tasks }));
  assert.equal(fourth.tasks.length, 2);
});

test('Finished keeps the newest hundred, after the running ones', () => {
  const prev = Array.from({ length: 105 }, (_, i) => ({
    ...C.buildCodexTasks(input({ terminals: [term(`p${i}`)] })).tasks[0],
    status: 'completed',
    completedAt: i,
  }));
  const running = C.buildCodexTasks(input({ terminals: [term('live')] })).tasks;
  const { tasks } = C.buildCodexTasks(input({ terminals: [term('live')], prev: [...prev, ...running] }));
  assert.equal(tasks.length, 101);
  assert.equal(tasks[0].id, 'codex-shell:live');
  assert.equal(tasks[1].completedAt, 104);
  assert.equal(tasks[100].completedAt, 5);
  // a finished one without an end time sorts last
  const odd = C.buildCodexTasks(input({ terminals: null, prev: [{ ...prev[0], completedAt: null }, prev[1]] })).tasks;
  assert.deepEqual(
    odd.map((t) => t.completedAt),
    [1, null],
  );
});

test('task events, process ids and shell output', () => {
  const shell = {
    ...C.buildCodexTasks(input({ terminals: [term('p')] })).tasks[0],
    status: 'completed',
    startedAt: 1000,
    completedAt: 3500,
  };
  assert.deepEqual(C.taskEvent(shell), {
    taskId: 'codex-shell:p',
    kind: 'shell',
    title: 'run p',
    status: 'completed',
    durationMs: 2500,
    toolUseId: 'item-p',
  });
  assert.equal(C.taskEvent({ ...shell, type: 'local_agent', completedAt: null }).kind, 'agent');
  assert.equal(C.taskEvent({ ...shell, completedAt: null }).durationMs, null);
  assert.equal(C.shellProcessId(shell), 'p');
  assert.equal(C.shellProcessId({ id: 'codex-agent:c' }), null);
  assert.equal(C.agentTaskId('c'), 'codex-agent:c');
  const turns = [
    { items: [{ type: 'agentMessage', id: 'item-p' }] },
    {
      items: [
        { type: 'commandExecution', id: 'item-p', aggregatedOutput: 'hello\n' },
        { type: 'commandExecution', id: 'item-q', aggregatedOutput: null },
      ],
    },
  ];
  assert.equal(C.codexShellOutput(turns, 'item-p'), 'hello\n');
  // on screen with no output yet: empty, not unavailable; not on screen at all: unavailable
  assert.equal(C.codexShellOutput(turns, 'item-q'), '');
  assert.equal(C.codexShellOutput(turns, 'none'), null);
});

test('shell reconciliation scans command history once for all retained finished tasks', () => {
  let visits = 0;
  const items = Array.from({ length: 10_000 }, (_, i) => ({
    get type() {
      visits++;
      return 'commandExecution';
    },
    id: `unrelated-${i}`,
    exitCode: 0,
  }));
  const prev = C.buildCodexTasks(input({ terminals: Array.from({ length: C.FINISHED_MAX }, (_, i) => term(`done-${i}`)) })).tasks;
  const completed = C.buildCodexTasks(input({ prev })).tasks;
  const result = C.buildCodexTasks(input({ turns: [{ items }], prev: completed }));
  assert.equal(result.tasks.length, C.FINISHED_MAX);
  assert.equal(
    result.tasks.every((task) => task.status === 'completed'),
    true,
  );
  assert.equal(result.settled.length, 0);
  // One agent-discovery pass plus one shared command-status pass, independent of task count.
  assert.ok(visits <= items.length * 2, `expected at most ${items.length * 2} item visits, got ${visits}`);
});

test('shell failure lookup keeps the first command match and exact opaque IDs', () => {
  const ids = ['__proto__', 'constructor', 'colon:quote"\\slash', '', 'missing', 'late'];
  const prev = C.buildCodexTasks(input({ terminals: ids.map((id, i) => term(String(i), { itemId: id })) })).tasks;
  const command = (id: unknown, exitCode?: unknown) => ({ type: 'commandExecution', id, exitCode });
  const turns = [
    { items: [null, { type: 'agentMessage', id: ids[0] }, command(ids[0], 2), command(ids[1]), command(ids[2], '2')] },
    { items: [command(ids[0], 0), command(ids[1], 3), command(ids[2], 4), command(null, -1), command('late', 0)] },
  ];
  const first = C.buildCodexTasks(input({ turns, prev }));
  assert.deepEqual(
    first.tasks.map((task) => task.status),
    ['failed', 'completed', 'completed', 'failed', 'completed', 'completed'],
  );
  assert.equal(first.settled.length, ids.length);
  // Every invocation reads its own snapshot: a late exit code is seen, without another settlement event.
  const late = C.buildCodexTasks(input({ turns: [{ items: [command('late', 9)] }], prev: first.tasks }));
  assert.equal(late.tasks.find((task) => task.toolUseId === 'late')?.status, 'failed');
  assert.equal(late.settled.length, 0);
  // The same IDs in another chat/history must never reuse the previous call's failure index.
  const other = C.buildCodexTasks(input({ turns: [], prev }));
  assert.equal(
    other.tasks.every((task) => task.status === 'completed'),
    true,
  );
});

test('shell failure lookup preserves strict equality for malformed NaN IDs', () => {
  const prev = C.buildCodexTasks(input({ terminals: [term('nan', { itemId: NaN })] })).tasks;
  // A malformed persisted task can carry NaN even though the terminal translator normally supplies strings.
  const malformed = { ...prev[0], toolUseId: NaN };
  const turns = [{ items: [{ type: 'commandExecution', id: NaN, exitCode: 7 }] }];
  const result = C.buildCodexTasks(input({ turns, prev: [malformed] }));
  assert.equal(result.tasks[0].status, 'completed');
});
