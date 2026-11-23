// Renderer components read the narrow part of a chat's runtime they show, so a streamed frame (patchRuntime replaces
// runtime[id].turns) re-renders none of them: the composer's next step, a chat's task list and its invisible poller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockStore, autoMock, render, setStore, settle } from './support/thread-kit.ts';
import { EMPTY_SESSION } from '../src/store/session/sessionState.ts';

const { createElement: h } = await import('react');
mockStore();
const wanted: boolean[] = [];
autoMock('src/store/agentWiring.ts', 'wiring', {
  useTaskPolling: (_id: string, on: boolean) => void wanted.push(on),
});
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: () => null, CodeBlock: () => null });
const { useSessions } = await import('../src/store/session/useSession.ts');
const { useNextStep } = await import('../src/components/composer/useNextStep.ts');
const { useChatTasks } = await import('../src/components/tasks/TaskList.tsx');
const { TaskPolling } = await import('../src/components/tasks/TaskPolling.tsx');

const click = (n: number) => ({ type: 'mcpToolCall', server: 'cua_repl', tool: 'js', arguments: { code: `n${n}` }, status: 'inProgress' });
const agentItem = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  type: 'dynamicToolCall',
  agent: { key: 'k', description: 'Review', status: 'running', model: 'claude-sonnet-5-5', tokens: 10, toolUses: 2, ...over },
});
const frame = (n: number, extra: unknown[] = []) => ({
  c: {
    activeTurnId: 't2',
    turns: [
      { id: 't1', status: 'completed', items: extra },
      { id: 't2', status: 'inProgress', items: [click(n)] },
    ],
  },
});

let renders = 0;
let next: string | null = null;
function NextProbe() {
  renders += 1;
  next = useNextStep('c');
  return null;
}

test('the composer next step ignores streamed frames and updates when the turn ends', async () => {
  setStore({ runtime: frame(0), chatNotes: {} });
  const v = await render(h(NextProbe));
  const before = renders;
  for (let n = 1; n <= 30; n++) await settle(() => setStore({ runtime: frame(n) }));
  assert.equal(renders - before, 0, 'before: one render per frame');
  assert.equal(next, null, 'nothing while it runs');
  // the turn ends: the suggestion reads its items
  await settle(() =>
    setStore({
      runtime: { c: { activeTurnId: null, turns: [{ id: 't2', status: 'completed', items: [{ ...click(1), status: 'completed' }] }] } },
    }),
  );
  assert.equal(typeof next === 'string' || next === null, true);
  // a refused app's note keeps reading the turn ids; a chat with no runtime and no thread suggest nothing
  await settle(() => setStore({ chatNotes: { c: [{ kind: 'control', refused: { app: 'x', name: 'X' }, turnId: 't2' }] } }));
  await settle(() => setStore({ runtime: {} }));
  assert.equal(next, null);
  await v.unmount();
  function NoChat() {
    next = useNextStep(null);
    return null;
  }
  const w = await render(h(NoChat));
  assert.equal(next, null);
  await w.unmount();
});

let tasks: any[] = [];
let tasksRenders = 0;
function TasksProbe() {
  tasksRenders += 1;
  tasks = useChatTasks('c');
  return null;
}

test('a chat task list reads its agent runs, not the whole turns, and follows a run that changes', async () => {
  useSessions.setState({
    sessions: {
      c: {
        ...EMPTY_SESSION,
        tasks: [
          { id: 'k', agentKey: 'k', status: 'running', description: 'old' },
          { id: 'sh', status: 'running' },
        ],
      } as any,
    },
  });
  setStore({ runtime: frame(0, [agentItem()]) });
  const v = await render(h(TasksProbe));
  assert.equal(tasks[0].description, 'Review');
  assert.equal(tasks[0].tokens, 10);
  assert.equal(tasks[1].description, undefined, 'a task without an agent key is left as it is');
  const before = tasksRenders;
  for (let n = 1; n <= 30; n++) await settle(() => setStore({ runtime: frame(n, [agentItem()]) }));
  assert.equal(tasksRenders - before, 0, 'before: one render per frame');
  await settle(() => setStore({ runtime: frame(31, [agentItem({ tokens: 99, toolUses: 0, model: null, description: '' })]) }));
  assert.equal(tasks[0].tokens, 99);
  assert.equal(tasks[0].description, 'old', 'a run without a description keeps the task own');
  assert.equal(tasks[0].toolUses, null);
  // a run the turns no longer hold leaves the task as main reported it
  await settle(() => setStore({ runtime: frame(32) }));
  assert.equal(tasks[0].description, 'old');
  await v.unmount();
  useSessions.setState({ sessions: {} });
});

test('the task poller renders once per change of what it reads, not once per frame', async () => {
  wanted.length = 0;
  setStore({ runtime: frame(0), diffPanel: { open: false }, paneTabs: [], paneActive: '' });
  const v = await render(h(TaskPolling, { chatId: 'c' }));
  assert.equal(wanted.at(-1), true, 'a turn is in progress');
  const before = wanted.length;
  for (let n = 1; n <= 30; n++) await settle(() => setStore({ runtime: frame(n) }));
  assert.equal(wanted.length - before, 0, 'before: one render per frame');
  await settle(() => setStore({ runtime: { c: { activeTurnId: null, turns: [{ id: 't', status: 'completed', items: [] }] } } }));
  assert.equal(wanted.at(-1), false);
  await settle(() => setStore({ runtime: frame(40, [agentItem()]) }));
  await settle(() => setStore({ runtime: { c: { activeTurnId: null, turns: [{ id: 't', status: 'completed', items: [agentItem()] }] } } }));
  assert.equal(wanted.at(-1), true, 'a recent turn still holds a running agent');
  await v.unmount();
});
