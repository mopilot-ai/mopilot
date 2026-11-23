// The invisible poller a chat view mounts (src/components/tasks/TaskPolling.tsx): Codex tasks are polled while a turn runs,
// the tasks tab is open, or a task runs, and not otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { mockSource, fakeStore, stubStore } from './support/stubs.ts';
import { createElement, act } from 'react';

const store = fakeStore<any>({ runtime: {}, diffPanel: { open: false }, paneTabs: [], paneActive: '' });
const f = { tasks: [] as any[], polled: [] as boolean[] };
stubStore({ useStore: store.useStore });
mockSource('src/store/agentWiring.ts', {
  useTaskPolling: (_id: string, wanted: boolean) => void f.polled.push(wanted),
  wireAgentSurfaces: () => {},
});
mockSource('src/components/tasks/TaskList.tsx', { useChatTasks: () => f.tasks, TaskList: () => null });

const { TaskPolling } = await import('../src/components/tasks/TaskPolling.tsx');
const { useSessions } = await import('../src/store/session/useSession.ts');
const B = await import('../src/store/backgroundTasks.ts');
const { createRoot } = await import('react-dom/client');

test('polls while a turn runs, while the tasks tab is open, and while a task runs', async () => {
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  const last = () => f.polled[f.polled.length - 1];
  await act(() => root.render(createElement(TaskPolling, { chatId: 'c' })));
  assert.equal(last(), false);
  assert.equal(host.innerHTML, '');
  await act(() => store.setState({ runtime: { c: { turns: [{ status: 'inProgress', items: [] }] } } }));
  assert.equal(last(), true);
  await act(() => store.setState({ runtime: { c: { turns: [{ status: 'completed', items: [] }] } } }));
  assert.equal(last(), false);
  await act(() => store.setState({ diffPanel: { open: true }, paneTabs: [{ id: 't', kind: 'tasks', threadId: 'c' }], paneActive: 't' }));
  assert.equal(last(), true);
  await act(() =>
    store.setState({ diffPanel: { open: true }, paneTabs: [{ id: 't', kind: 'tasks', threadId: 'other' }], paneActive: 't' }),
  );
  assert.equal(last(), false);
  f.tasks = [{ id: 'x', status: 'running' }];
  await act(() => root.render(createElement(TaskPolling, { chatId: 'c' })));
  assert.equal(last(), true);
  f.tasks = [];
  await act(() => root.render(createElement(TaskPolling, { chatId: 'c' })));
  assert.equal(last(), false);
  // a recent turn holding an agent still marked running (a reopened chat) is read once; a settled one, or an old one, is not
  const agentTurn = (status: string) => ({
    status: 'completed',
    items: [{ type: 'collabAgentToolCall', tool: 'spawnAgent', id: 'a', receiverThreadIds: ['k'], agentsStates: { k: { status } } }],
  });
  await act(() => store.setState({ runtime: { c: { turns: [agentTurn('running')] } } }));
  assert.equal(last(), true);
  await act(() => store.setState({ runtime: { c: { turns: [agentTurn('completed')] } } }));
  assert.equal(last(), false);
  const idle = { status: 'completed', items: [] };
  await act(() => store.setState({ runtime: { c: { turns: [agentTurn('running'), idle, idle, idle, idle, idle] } } }));
  assert.equal(last(), false);
  // the latest turn's command still running (left running, or not yet ended by a Stop) keeps the poll on (#1940)
  const cmdTurn = (status: string) => ({ status: 'completed', items: [{ type: 'commandExecution', id: 'x', status }] });
  await act(() => store.setState({ runtime: { c: { turns: [cmdTurn('inProgress')] } } }));
  assert.equal(last(), true);
  await act(() => store.setState({ runtime: { c: { turns: [cmdTurn('completed')] } } }));
  assert.equal(last(), false);
  await act(() => store.setState({ runtime: { c: { turns: [cmdTurn('inProgress'), idle] } } }));
  assert.equal(last(), false);
  await act(() => store.setState({ runtime: { c: { turns: [] } } }));
  assert.equal(last(), false);
  await act(() => root.unmount());
});

test('polls a chat main counts background work for, so a window that never listed it (reloaded, opened later) lists it', async () => {
  B.setAdapterTaskSourceResolver((id) => JSON.stringify(['codex', id]));
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  const last = () => f.polled[f.polled.length - 1];
  const work = (key: string) => ({ source: { kind: 'codex', key }, shells: 1, agents: 0 });
  await act(() => store.setState({ runtime: {}, diffPanel: { open: false }, paneTabs: [], paneActive: '' }));
  await act(() => root.render(createElement(TaskPolling, { chatId: 'c' })));
  assert.equal(last(), false);
  await act(() => useSessions.setState({ sessions: { c: { backgroundWork: work('c') } as any } }));
  assert.equal(last(), true);
  await act(() => useSessions.setState({ sessions: { c: { backgroundWork: work('switched-away') } as any } }));
  assert.equal(last(), false, "another segment's work is not this chat's to list");
  await act(() => useSessions.setState({ sessions: { c: { backgroundWork: work('c') } as any } }));
  await act(() => useSessions.setState({ sessions: {} }));
  assert.equal(last(), false);
  await act(() => root.unmount());
  B.setAdapterTaskSourceResolver((id) => id);
});
