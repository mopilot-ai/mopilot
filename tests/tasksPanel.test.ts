// The Background tasks model (src/lib/tasks.ts, dismissedTasks.ts, taskEvents.ts): titles, words, sections, the shared clock,
// cleared tasks kept per chat in localStorage, transcript task events folded and grouped, Codex child threads and the double Esc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { createElement, act } from 'react';
import * as T from '../src/lib/tasks.ts';
import {
  foldTaskEvents,
  noteEvents,
  eventHeadline,
  eventsWithoutRow,
  groupParts,
  groupSummary,
  reconcileEvents,
} from '../src/lib/taskEvents.ts';
import { childThreads } from '../src/harness/codexTranslate.ts';

const { createRoot } = await import('react-dom/client');
const loadDismissed = (q: string) =>
  import(`../src/lib/dismissedTasks.ts?case=${q}`) as Promise<typeof import('../src/lib/dismissedTasks.ts')>;
const { escStep } = T;

const task = (o: object): any => ({
  id: 't',
  type: 'local_agent',
  description: '',
  status: 'running',
  summary: null,
  toolUseId: null,
  subagentType: null,
  workflowName: null,
  parentTaskId: null,
  ambient: false,
  ...o,
});

test('titles, status words, elapsed time, tokens and running verbs', () => {
  // Claude names a command: its description is the title, the command shows when the card opens
  assert.equal(T.taskTitle(task({ type: 'local_bash', command: 'npm test', description: 'Run the tests' })), 'Run the tests');
  assert.equal(T.taskTitle(task({ type: 'local_bash', description: 'tests' })), 'tests');
  // Codex sends the command as the description, or none: the command, shortened
  assert.equal(
    T.taskTitle(task({ type: 'local_bash', command: "python3 - <<'PY'\nprint(1)\nPY", description: "python3 - <<'PY'\nprint(1)\nPY" })),
    'python3 script',
  );
  assert.equal(T.taskTitle(task({ type: 'local_bash', command: 'npm test', description: null })), 'npm test');
  assert.equal(T.taskTitle(task({ type: 'local_agent', command: 'x', description: 'Review' })), 'Review');
  assert.equal(T.taskTitle(task({ summary: 'doing' })), 'doing');
  assert.equal(T.taskTitle(task({ id: 'x' })), 'x');
  assert.deepEqual(['running', 'completed', 'failed', 'stopped'].map(T.statusWord), [null, 'Completed', 'Failed', 'Stopped']);
  assert.equal(T.isRunningTask({ status: 'pending' }), true);
  assert.equal(T.isRunningTask({ status: 'paused' }), true);
  assert.equal(T.isRunningTask({ status: 'stopped' }), false);
  assert.equal(T.taskElapsed({ startedAt: null }, 5), null);
  assert.equal(T.taskElapsed({ startedAt: 1000 }, 4000), 3000);
  assert.equal(T.taskElapsed({ startedAt: 1000, completedAt: 2000 }, 9000), 1000);
  assert.equal(T.taskElapsed({ startedAt: 5000 }, 4000), 0);
  assert.deepEqual([950, 99_100, 165_400, 2000, 1_200_000, 3_000_000].map(T.formatTokens), [
    '950 tokens',
    '99.1k tokens',
    '165.4k tokens',
    '2k tokens',
    '1.2M tokens',
    '3M tokens',
  ]);
  assert.equal(T.formatTokens(999_950), '1M tokens', 'not 1000k tokens');
  assert.equal(T.toolVerb('Bash'), 'Running a command');
  assert.equal(T.toolVerb('Read'), 'Reading a file');
  assert.equal(T.toolVerb('mcp__my_server__do_it'), 'Using my_server');
  assert.equal(T.toolVerb('Frobnicate'), 'Using Frobnicate');
  assert.deepEqual(
    [T.runningLabel(1), T.runningLabel(3), T.finishedLabel(1), T.finishedLabel(2)],
    ['1 running task', '3 running tasks', '1 task finished', '2 tasks finished'],
  );
  assert.deepEqual([T.outputPollMs(10), T.outputPollMs(200 * 1024), T.outputPollMs(600 * 1024)], [2000, 5000, 10000]);
  assert.deepEqual([1, 2, 3, 9].map(T.outputRetryMs), [10_000, 20_000, 40_000, 60_000]);
  assert.equal(T.outputRetryMs(0), 10_000);
});

test('a command title: first line, no cd prefix, no heredoc body; an interpreter fed a heredoc is a script', () => {
  assert.equal(T.commandTitle('npm test'), 'npm test');
  assert.equal(T.commandTitle('\n\n  npm run build  \nnext'), 'npm run build');
  assert.equal(T.commandTitle('cd /repo && npm test'), 'npm test');
  assert.equal(T.commandTitle('cd "/my repo" && make'), 'make');
  assert.equal(T.commandTitle("cd '/a b' &&make"), 'make');
  assert.equal(T.commandTitle("python3 - <<'PY'\np='x'\nPY"), 'python3 script');
  assert.equal(T.commandTitle('node - <<EOF'), 'node script');
  assert.equal(T.commandTitle('bash -<<-"SH"'), 'bash script');
  assert.equal(T.commandTitle("cat >> web/tests/a.test.ts <<'EOF'\ntest('x')\nEOF"), 'cat >> web/tests/a.test.ts');
  // what follows the marker on its line stays: where the text goes
  assert.equal(T.commandTitle("cat <<'EOF' > config.json\n{}\nEOF"), 'cat > config.json');
  assert.equal(T.commandTitle('<<EOF'), '<<EOF');
  assert.equal(T.commandTitle(''), '');
});

test('sections: running and finished tops, children nested under a shown parent, orphans and self-parents on top', () => {
  const { running, finished } = T.taskSections([
    task({ id: 'w', type: 'local_workflow' }),
    task({ id: 'a', parentTaskId: 'w', status: 'completed' }),
    task({ id: 'b', parentTaskId: 'gone' }),
    task({ id: 'c', status: 'failed' }),
    task({ id: 's', parentTaskId: 's', status: 'stopped' }),
  ]);
  assert.deepEqual(
    running.map((n) => [n.task.id, n.children.map((c) => c.task.id)]),
    [
      ['w', ['a']],
      ['b', []],
    ],
  );
  assert.deepEqual(
    finished.map((n) => [n.task.id, n.children.length]),
    [
      ['c', 0],
      ['s', 0],
    ],
  );
});

test('sections: a finished card stays in Running while anything nested in it runs', () => {
  const { running, finished } = T.taskSections([
    task({ id: 'p', status: 'completed' }),
    task({ id: 'k', parentTaskId: 'p', status: 'running' }),
    task({ id: 'q', status: 'completed' }),
    task({ id: 'r', parentTaskId: 'q', status: 'completed' }),
  ]);
  assert.deepEqual(
    running.map((n) => [n.task.id, n.children.map((c) => c.task.id)]),
    [['p', ['k']]],
  );
  assert.deepEqual(
    finished.map((n) => [n.task.id, n.children.map((c) => c.task.id)]),
    [['q', ['r']]],
  );
});

test('every live timer reads one shared clock that ticks only while one is active', async () => {
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  const Probe = ({ on }: { on: boolean[] }) =>
    createElement(
      'i',
      null,
      on.map((a, i) => createElement(Tick, { key: i, active: a })),
    );
  const seen: number[] = [];
  const Tick = ({ active }: { active: boolean }) => {
    seen.push(T.useTaskClock(active));
    return null;
  };
  await act(() => root.render(createElement(Probe, { on: [true, true] })));
  const before = seen.length;
  await act(() => new Promise((r) => setTimeout(r, 1100)));
  assert.ok(seen.length >= before + 2, 'both timers re-rendered on the tick');
  assert.ok(seen[seen.length - 1] > seen[0]);
  await act(() => root.render(createElement(Probe, { on: [false] })));
  const idle = seen.length;
  await act(() => new Promise((r) => setTimeout(r, 1100)));
  assert.equal(seen.length, idle, 'no tick without an active timer');
  // a timer starting again restarts the tick
  await act(() => root.render(createElement(Probe, { on: [true] })));
  await act(() => root.unmount());
});

test('cleared tasks persist per chat, capped, and survive unreadable or blocked storage', async () => {
  const store = new Map<string, string>();
  const ls: any = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  };
  (globalThis as any).localStorage = ls;
  store.set('mopilot.dismissedTasks', JSON.stringify({ c0: ['x', 5], bad: 'nope' }));
  const D = await loadDismissed('persist');
  assert.deepEqual([...D.dismissedIds('c0')], ['x']);
  assert.equal(D.dismissedIds('bad').size, 0);
  assert.equal(D.dismissedIds('none'), D.dismissedIds('none'));
  D.dismissTasks('c1', ['a', 'b']);
  D.dismissTasks('c1', ['b', 'c']);
  assert.deepEqual([...D.dismissedIds('c1')], ['a', 'b', 'c']);
  assert.deepEqual(JSON.parse(store.get('mopilot.dismissedTasks')!).c1, ['a', 'b', 'c']);
  D.undismissTasks('c1', ['b']);
  assert.deepEqual([...D.dismissedIds('c1')], ['a', 'c']);
  D.undismissTasks('c1', ['a', 'c']);
  assert.ok(!('c1' in JSON.parse(store.get('mopilot.dismissedTasks')!)));
  D.undismissTasks('never', ['z']);
  // 1000 ids a chat, 100 chats: the chat cleared longest ago goes first
  D.dismissTasks(
    'big',
    Array.from({ length: 1005 }, (_, i) => `t${i}`),
  );
  assert.equal(D.dismissedIds('big').size, 1000);
  assert.ok(D.dismissedIds('big').has('t1004') && !D.dismissedIds('big').has('t0'));
  for (let i = 0; i < 101; i++) D.dismissTasks(`chat${i}`, ['q']);
  const saved = JSON.parse(store.get('mopilot.dismissedTasks')!);
  assert.equal(Object.keys(saved).length, 100);
  assert.ok(!('c0' in saved) && !('big' in saved) && 'chat100' in saved);
  // writes that throw keep the ids for this window
  ls.setItem = () => {
    throw new Error('full');
  };
  D.dismissTasks('w', ['1']);
  assert.ok(D.dismissedIds('w').has('1'));
  // a hook re-renders on changes
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  const Probe = () => createElement('i', null, [...D.useDismissedIds('h')].join(','));
  await act(() => root.render(createElement(Probe)));
  assert.equal(host.textContent, '');
  await act(() => D.dismissTasks('h', ['k']));
  assert.equal(host.textContent, 'k');
  await act(() => root.unmount());
  // storage that can't be read starts empty
  ls.getItem = () => {
    throw new Error('blocked');
  };
  const E = await loadDismissed('blocked');
  assert.equal(E.dismissedIds('c1').size, 0);
  store.clear();
  ls.getItem = () => null;
  const F = await loadDismissed('empty');
  assert.equal(F.dismissedIds('c1').size, 0);
  delete (globalThis as any).localStorage;
});

test('a collapsed Finished section is remembered per chat in localStorage, capped, and survives unreadable or blocked storage', async () => {
  const store = new Map<string, string>();
  const ls: any = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  (globalThis as any).localStorage = ls;
  const load = (q: string) => import(`../src/lib/finishedOpen.ts?case=${q}`) as Promise<typeof import('../src/lib/finishedOpen.ts')>;
  store.set('mopilot.finishedClosed', JSON.stringify(['c0', 7]));
  const A = await load('saved');
  assert.deepEqual([A.finishedOpenFor('c0'), A.finishedOpenFor('c1')], [false, true]);
  A.setFinishedOpen('c1', false);
  A.setFinishedOpen('c0', true);
  assert.deepEqual(JSON.parse(store.get('mopilot.finishedClosed')!), ['c1']);
  for (let i = 0; i < 120; i++) A.setFinishedOpen(`k${i}`, false);
  const kept = JSON.parse(store.get('mopilot.finishedClosed')!);
  assert.deepEqual([kept.length, kept[0], kept.at(-1)], [100, 'k20', 'k119']);
  // storage that can't be written still holds for this window; one that can't be read starts open
  ls.setItem = () => {
    throw new Error('full');
  };
  A.setFinishedOpen('late', false);
  assert.equal(A.finishedOpenFor('late'), false);
  ls.getItem = () => {
    throw new Error('blocked');
  };
  const B = await load('blocked');
  assert.equal(B.finishedOpenFor('c1'), true);
  ls.getItem = () => 'not json';
  const C = await load('garbage');
  assert.equal(C.finishedOpenFor('c1'), true);
  ls.getItem = () => '{"a":1}';
  const D = await load('object');
  assert.equal(D.finishedOpenFor('a'), true);
  delete (globalThis as any).localStorage;
});

const note = (id: string, ev: any) => ({ type: 'statusNote', id, kind: 'task', text: '', task: ev });
const ev = (taskId: string, status = 'running', kind = 'shell', extra: object = {}) => ({
  taskId,
  kind,
  title: taskId,
  status,
  durationMs: null,
  ...extra,
});

test('task events: one per task at its first place with its latest state; neighbours group', () => {
  const plain = [{ type: 'agentMessage', id: 'm' }];
  assert.equal(foldTaskEvents(plain), plain);
  const items: any[] = [
    note('n1', ev('a')),
    note('n2', ev('b')),
    { type: 'agentMessage', id: 'm' },
    note('n3', ev('a', 'completed')),
    { type: 'statusNote', id: 'other', kind: 'limit', text: 'x' },
    { type: 'statusNote', id: 'bare', kind: 'task', text: 'no task' },
    note('n4', ev('c')),
    note('n5', ev('b', 'failed')),
    note('n6', ev('d')),
  ];
  const out = foldTaskEvents(items) as any[];
  assert.deepEqual(
    out.map((i) => i.id),
    ['n1', 'm', 'other', 'bare', 'n4'],
  );
  assert.deepEqual(
    out[0].events.map((e: any) => [e.taskId, e.status]),
    [
      ['a', 'completed'],
      ['b', 'failed'],
    ],
  );
  assert.equal(out[0].task.status, 'completed');
  assert.deepEqual(
    out[4].events.map((e: any) => e.taskId),
    ['c', 'd'],
  );
  assert.deepEqual(noteEvents(out[4]), out[4].events);
  assert.deepEqual(noteEvents(note('x', ev('z')) as any), [ev('z')]);
});

test('task event words: one settled event, and a group by status', () => {
  assert.equal(eventHeadline(ev('a', 'completed') as any), 'Background command completed');
  assert.equal(eventHeadline(ev('a', 'failed', 'agent') as any), 'Background agent failed');
  assert.equal(groupSummary([ev('a', 'completed'), ev('b')] as any), '1 background command completed, 1 running');
  assert.equal(
    groupSummary([ev('a', 'completed'), ev('b', 'completed', 'agent'), ev('c', 'failed'), ev('d', 'stopped'), ev('e')] as any),
    '2 background tasks completed, 1 failed, 1 stopped, 1 running',
  );
  assert.equal(groupSummary([ev('a', 'running', 'workflow'), ev('b', 'running', 'workflow')] as any), '2 background workflows running');
  assert.equal(
    groupSummary([ev('a', 'failed', 'monitor'), ev('b', 'stopped', 'monitor')] as any),
    '1 background monitor failed, 1 stopped',
  );
});

test('a group sums up in parts, the failures marked; a task its step row stands for has no event', () => {
  assert.deepEqual(groupParts([ev('a', 'completed'), ev('b', 'failed'), ev('c', 'failed')] as any), [
    { text: '1 background command completed', danger: false },
    { text: '2 failed', danger: true },
  ]);
  const mine = { ...ev('a', 'completed'), toolUseId: 'tu1' };
  const old = ev('b', 'completed');
  const free = ev('c', 'completed');
  assert.deepEqual(
    eventsWithoutRow([mine, old, free] as any, [
      { id: 'b', toolUseId: 'tu2' },
      { id: 'c', toolUseId: null },
    ]),
    [free],
  );
  assert.deepEqual(eventsWithoutRow([{ ...free, toolUseId: null }] as any, []), [{ ...free, toolUseId: null }]);
  // a monitor or workflow keeps its note: its tool row does not show the task; an agent's row does
  const monitor = { ...ev('m', 'running', 'monitor'), toolUseId: 'tu3' };
  const flow = { ...ev('w', 'completed', 'workflow'), toolUseId: 'tu4' };
  const agent = { ...ev('g', 'completed', 'agent'), toolUseId: 'tu5' };
  assert.deepEqual(eventsWithoutRow([monitor, flow, agent] as any, []), [monitor, flow]);
});

test('Codex child threads come from spawn calls, once each, numbered by spawn order', () => {
  const spawn = (id: string, receivers: string[]) => ({
    type: 'collabAgentToolCall',
    id,
    tool: 'spawnAgent',
    status: 'completed',
    receiverThreadIds: receivers,
  });
  assert.deepEqual(
    childThreads([spawn('a', ['th1'])]).map((c) => c.title),
    ['Agent'],
  );
  const two = childThreads([
    spawn('a', ['th1']),
    { type: 'collabAgentToolCall', id: 'w', tool: 'wait', receiverThreadIds: ['th1'] },
    spawn('b', ['th2', 'th1']),
  ]);
  assert.deepEqual(
    two.map((c) => [c.id, c.title]),
    [
      ['th1', 'Agent 1'],
      ['th2', 'Agent 2'],
    ],
  );
  assert.deepEqual(childThreads([{ type: 'agentMessage', id: 'm' }]), []);
});

test('a second Esc inside 2 seconds, with tasks live, offers Stop all', () => {
  const first = escStep(0, 10_000, 2);
  assert.deepEqual(first, { offer: false, lastEsc: 10_000 });
  assert.deepEqual(escStep(first.lastEsc, 11_500, 2), { offer: true, lastEsc: 0 });
  // too late, or nothing to stop: only remembered
  assert.equal(escStep(first.lastEsc, 12_000, 2).offer, false);
  assert.equal(escStep(first.lastEsc, 10_500, 0).offer, false);
});

test('a running event whose task settled shows how it ended; others stay as they are', () => {
  const t = (id: string, status: string, extra: object = {}) => ({ id, status, ...extra }) as any;
  const events = [ev('a'), ev('b'), ev('c'), ev('d'), ev('e'), ev('f', 'completed')] as any[];
  const out = reconcileEvents(events, [
    t('a', 'completed', { startedAt: 1000, completedAt: 4000 }),
    t('b', 'failed'),
    t('c', 'killed'),
    t('d', 'stopped'),
    t('e', 'running'),
    t('f', 'failed'),
  ]);
  assert.deepEqual(
    out.map((e) => [e.status, e.durationMs]),
    [
      ['completed', 3000],
      ['failed', null],
      ['stopped', null],
      ['stopped', null],
      ['running', null],
      ['completed', null],
    ],
  );
  assert.equal(reconcileEvents(events, [])[0], events[0]);
  // a paused or pending task has not settled: its event still runs
  const waiting = [ev('p'), ev('q')] as any[];
  assert.deepEqual(reconcileEvents(waiting, [t('p', 'paused'), t('q', 'pending')]), waiting);
});
