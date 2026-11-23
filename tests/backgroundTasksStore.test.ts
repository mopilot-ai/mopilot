// The harness-neutral background task store (src/store/backgroundTasks.ts): adapter tasks merge under main's,
// stops show "Stopping…" while in flight and report refusals, a chat without a stopper can't stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { createElement, act } from 'react';

const { createRoot } = await import('react-dom/client');
const B = await import('../src/store/backgroundTasks.ts');
const task = (id: string, extra: any = {}) =>
  ({
    id,
    type: null,
    description: id,
    status: 'running',
    summary: null,
    toolUseId: null,
    subagentType: null,
    workflowName: null,
    parentTaskId: null,
    ambient: false,
    ...extra,
  }) as any;

test('mergeTasks keeps main first and drops adapter duplicates', () => {
  const s = [task('a')];
  assert.equal(B.mergeTasks(s, []), s);
  assert.deepEqual(
    B.mergeTasks(s, [task('a', { description: 'x' }), task('b')]).map((t: any) => t.id),
    ['a', 'b'],
  );
});

test('stopBackgroundTask marks the task stopping until the harness answers', async () => {
  assert.equal(await B.stopBackgroundTask('c', task('a')), false);
  let release!: (v: boolean) => void;
  B.setTaskStopperResolver((chat) =>
    chat === 'c'
      ? () => new Promise<boolean>((r) => (release = r))
      : async () => {
          throw new Error('no');
        },
  );
  const p = B.stopBackgroundTask('c', task('a'));
  assert.ok(B.stoppingIds('c').has('a'));
  release(true);
  assert.equal(await p, true);
  assert.equal(B.stoppingIds('c').has('a'), false);
  assert.equal(await B.stopBackgroundTask('d', task('a')), false);
  assert.equal(await B.stopBackgroundTask('c', task('a', { stoppable: false })), false);
});

test('hooks follow adapter tasks and stops', async () => {
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  const Probe = () => {
    const tasks = B.useAdapterTasks('h');
    const stopping = B.useStoppingIds('h');
    return createElement('i', null, `${tasks.map((t: any) => t.id).join(',')}|${[...stopping].join(',')}`);
  };
  await act(() => root.render(createElement(Probe)));
  assert.equal(host.textContent, '|');
  await act(() => B.putAdapterTasks('h', [task('x')]));
  assert.equal(host.textContent, 'x|');
  let release!: (v: boolean) => void;
  B.setTaskStopperResolver(() => () => new Promise<boolean>((r) => (release = r)));
  let p: Promise<boolean | 'retired'>;
  await act(async () => {
    p = B.stopBackgroundTask('h', task('x'));
  });
  assert.equal(host.textContent, 'x|x');
  await act(async () => {
    release(false);
    await p;
  });
  assert.equal(host.textContent, 'x|');
  await act(() => B.putAdapterTasks('h', []));
  assert.equal(host.textContent, '|');
  await act(() => root.unmount());
});

test('a chat reads task output through the reader its adapter registers, or has none', async () => {
  assert.equal(B.taskOutputReader('c'), null);
  B.setTaskOutputReaderResolver((chat) => (chat === 'c' ? async (t) => `out ${t.id}` : null));
  assert.equal(await B.taskOutputReader('c')!(task('a')), 'out a');
  assert.equal(B.taskOutputReader('d'), null);
});

test('adapter tasks are hidden as soon as the selected native source changes', async () => {
  let source = 'codex:first';
  B.setAdapterTaskSourceResolver(() => source);
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  const Probe = () =>
    createElement(
      'i',
      null,
      B.useAdapterTasks('scoped')
        .map((task) => task.id)
        .join(','),
    );
  await act(() => root.render(createElement(Probe)));
  await act(() => B.putAdapterTasks('scoped', [task('first')]));
  assert.equal(host.textContent, 'first');
  source = 'claude:second';
  await act(() => root.render(createElement(Probe)));
  assert.equal(host.textContent, '');
  await act(() => B.putAdapterTasks('scoped', [task('second')]));
  assert.equal(host.textContent, 'second');
  await act(() => root.unmount());
  B.setAdapterTaskSourceResolver((chatId) => chatId);
});

test('an old source stop cannot clear a replacement stop with the same task id', async () => {
  let source = 'first-native';
  B.setAdapterTaskSourceResolver(() => source);
  const answers: ((value: boolean) => void)[] = [];
  B.setTaskStopperResolver(() => () => new Promise((resolve) => answers.push(resolve)));
  const old = B.stopBackgroundTask('stop-scope', task('same-id'));
  assert.equal(await B.stopBackgroundTask('stop-scope', task('same-id')), false);
  assert.equal(answers.length, 1, 'one stop in flight per source and task');
  source = 'second-native';
  assert.equal(B.stoppingIds('stop-scope').size, 0);
  const current = B.stopBackgroundTask('stop-scope', task('same-id'));
  answers[0](true);
  assert.equal(await old, true);
  assert.equal(B.stoppingIds('stop-scope').has('same-id'), true);
  answers[1](false);
  assert.equal(await current, false);
  assert.equal(B.stoppingIds('stop-scope').size, 0);
  B.setAdapterTaskSourceResolver((chatId) => chatId);
});

test('owned jobs keep their stopping indicators across switches without losing other owners', async () => {
  let current = 'current-first';
  B.setAdapterTaskSourceResolver(() => current);
  const answers: ((value: boolean) => void)[] = [];
  B.setTaskStopperResolver(() => () => new Promise((resolve) => answers.push(resolve)));
  const first = task('first', { source: { kind: 'claude', key: 'first-native' } });
  const second = task('second', { source: { kind: 'claude', key: 'second-native' } });
  const a = B.stopBackgroundTask('owned-stops', first);
  current = 'current-second';
  const b = B.stopBackgroundTask('owned-stops', second);
  assert.equal(B.stoppingIds('owned-stops').has('first'), true);
  assert.equal(B.stoppingIds('owned-stops').has('second'), true);
  assert.equal(await B.stopBackgroundTask('owned-stops', first), false);
  answers[0](true);
  await a;
  assert.deepEqual([...B.stoppingIds('owned-stops')], ['second']);
  answers[1](true);
  await b;
  assert.equal(B.stoppingIds('owned-stops').size, 0);
  B.setAdapterTaskSourceResolver((chatId) => chatId);
});

test('a poll that read the same tasks keeps the list; any difference in the tasks replaces it', () => {
  const first = [task('same', { output: { kind: 'file', path: '/a' }, source: { kind: 'codex', key: 'k' } })];
  B.putAdapterTasks('eq', first);
  B.putAdapterTasks('eq', [task('same', { output: { kind: 'file', path: '/a' }, source: { kind: 'codex', key: 'k' }, model: undefined })]);
  assert.equal(B.adapterTasksOf('eq'), first, 'equal data, with an undefined field, changes nothing');
  const changes: any[] = [
    [task('same', { output: { kind: 'file', path: '/b' }, source: { kind: 'codex', key: 'k' } })],
    [task('same', { output: [], source: { kind: 'codex', key: 'k' } })],
    [task('same', { output: { kind: 'file', path: '/a' }, source: { kind: 'codex', key: 'k' }, model: 'm' })],
    [task('same', { output: null, source: { kind: 'codex', key: 'k' } })],
    [first[0], task('two')],
  ];
  for (const next of changes) {
    B.putAdapterTasks('eq', first);
    B.putAdapterTasks('eq', next);
    assert.equal(B.adapterTasksOf('eq'), next);
  }
  B.putAdapterTasks('eq', []);
});
