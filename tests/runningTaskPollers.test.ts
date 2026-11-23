// src/components/tasks/RunningTaskPollers.tsx: every listed chat with a Codex or ACP task still running keeps its
// tasks polled whether or not it is open, so its sidebar dot and tasks marker settle when the task does; a settled,
// housekeeping or unlisted chat's tasks start no poller.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render } from './support/pages-kit.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const store = fakeStore<any>({ threads: {} });
stubStore({ useStore: store.useStore });
mock.module('../src/components/tasks/TaskPolling.tsx', {
  namedExports: { TaskPolling: ({ chatId }: { chatId: string }) => h('i', { 'data-polling': chatId }) },
});
const B = await import('../src/store/backgroundTasks.ts');
const { RunningTaskPollers } = await import('../src/components/tasks/RunningTaskPollers.tsx');

const task = (id: string, o: object = {}): any => ({ id, type: 'local_bash', description: id, status: 'running', ambient: false, ...o });

test('a poller runs for each listed chat while one of its adapter tasks runs, and stops when they settle', async () => {
  await act(async () => store.setState({ threads: { a: { id: 'a' }, b: { id: 'b' } } }));
  const v = await render(h(RunningTaskPollers));
  const polling = () => [...v.host.querySelectorAll('[data-polling]')].map((e) => e.getAttribute('data-polling'));
  assert.deepEqual(polling(), []);
  await act(async () => {
    B.putAdapterTasks('a', [task('t1'), task('t2', { status: 'completed' })]);
    B.putAdapterTasks('b', [task('w', { ambient: true })]);
    B.putAdapterTasks('gone', [task('t3')]);
  });
  assert.deepEqual(polling(), ['a'], 'housekeeping is not work, and an unlisted chat is not polled');
  assert.deepEqual(B.chatsWithAdapterWork(), ['a', 'gone']);
  await act(async () => B.putAdapterTasks('b', [task('t4', { status: 'pending' })]));
  assert.deepEqual(polling(), ['a', 'b']);
  // the chat leaves the list (archived): its poller goes
  await act(async () => store.setState({ threads: { b: { id: 'b' } } }));
  assert.deepEqual(polling(), ['b']);
  await act(async () => B.putAdapterTasks('b', [task('t4', { status: 'completed' })]));
  assert.deepEqual(polling(), []);
  for (const id of ['a', 'b', 'gone']) B.putAdapterTasks(id, []);
  assert.deepEqual(B.chatsWithAdapterWork(), []);
  await v.unmount();
});
