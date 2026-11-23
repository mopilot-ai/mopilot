// src/session/chatRowState.ts and useChatRowState.ts with background tasks: a chat whose turn ended keeps the working state
// while a task still runs, as Claude Desktop keeps a session running while it has background work. Main's tasks
// (Claude Code) and an adapter's (Codex, ACP) count alike; housekeeping and settled tasks don't.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render } from './support/pages-kit.ts';
import { EMPTY_SESSION } from '../src/store/session/sessionState.ts';
import type { ChatRowInputs } from '../src/session/chatRowState.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const store = fakeStore<any>({ threads: {}, runtime: {}, pending: [], elsewhere: {}, unread: {}, agentTabs: {} });
let session: any = EMPTY_SESSION;
stubStore({ useStore: store.useStore, chatOf: (id: string) => id });
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => session,
    useSessionField: (id: any, pick: any) => pick(((() => session) as (id: any) => any)(id)),
    useSessionLoaded: () => true,
    refreshSession: async () => {},
    ensureSession: () => {},
    // every chat's session is the test's current one, read afresh on each render
    useSessions: (select: (s: any) => unknown) => select({ sessions: new Proxy({}, { get: () => session }) }),
  },
});
const { chatRowState, nestedTally } = await import('../src/session/chatRowState.ts');
const { useChatRowState } = await import('../src/session/useChatRowState.ts');
const B = await import('../src/store/backgroundTasks.ts');

const task = (id: string, o: object = {}): any => ({ id, type: 'local_bash', description: id, status: 'running', ambient: false, ...o });
const live = (over: Record<string, unknown>) => ({ ...EMPTY_SESSION, rev: 1, ...over }) as ChatRowInputs['session'];
const state = (over: Partial<ChatRowInputs> = {}) =>
  chatRowState({
    thread: { id: 'c', cwd: '/repo', status: { type: 'idle' } } as ChatRowInputs['thread'],
    session: EMPTY_SESSION,
    runtime: undefined,
    requests: [],
    adapterTasks: [],
    elsewhere: undefined,
    unread: false,
    ...over,
  });

test("a chat whose turn ended works on while one of main's or an adapter's tasks runs", () => {
  assert.equal(state({ session: live({ turn: 'idle', tasks: [task('a')] }) }), 'working', "main's task (Claude Code)");
  assert.equal(state({ session: live({ turn: 'idle' }), adapterTasks: [task('a')] }), 'working', "an adapter's task (Codex, ACP)");
  assert.equal(state({ adapterTasks: [task('a', { status: 'pending' })] }), 'working', 'before main has the session too');
  assert.equal(state({ adapterTasks: [task('a', { status: 'paused' })] }), 'working', 'a paused task has not settled');
  // settled tasks and housekeeping are not activity
  for (const status of ['completed', 'failed', 'killed', 'stopped'])
    assert.equal(state({ session: live({ tasks: [task('a', { status })] }) }), 'idle', status);
  assert.equal(state({ session: live({ tasks: [task('w', { ambient: true })] }), adapterTasks: [task('v', { ambient: true })] }), 'idle');
  // main's record of a task wins over the adapter's copy of the same id
  assert.equal(state({ session: live({ tasks: [task('a', { status: 'completed' })] }), adapterTasks: [task('a')] }), 'idle');
});

test('a running task works over an unread result, a finished report and another app, and yields to the user and a crash', () => {
  const tasks = [task('a')];
  assert.equal(state({ session: live({ tasks }), unread: true }), 'working');
  const linked = { lastReport: { how: 'finished' } } as ChatRowInputs['linked'];
  assert.equal(state({ session: live({ tasks }), linked }), 'working');
  assert.equal(state({ session: live({ tasks, runningElsewhere: true }) }), 'working');
  assert.equal(state({ session: live({ tasks, turn: 'awaitingUser' }) }), 'approval');
  assert.equal(state({ session: live({ tasks, approvals: [{ id: 'q', method: 'item/tool/requestUserInput', params: {} }] }) }), 'input');
  assert.equal(state({ session: live({ tasks, turn: 'crashed' }) }), 'error');
  assert.equal(nestedTally(state({ adapterTasks: tasks })), 'working', 'a hidden nested session counts as working');
});

let read: any = null;
function Probe({ id }: { id: string }) {
  read = useChatRowState(id);
  return null;
}

test("the row follows the adapter's tasks as they start and settle, and main's on the session", async () => {
  session = EMPTY_SESSION;
  await act(async () => store.setState({ threads: { c: { id: 'c', cwd: '/r' } } }));
  const v = await render(h(Probe, { id: 'c' }));
  assert.equal(read.state, 'idle');
  assert.equal(read.backgroundRunning, false);
  await act(async () => B.putAdapterTasks('c', [task('a')]));
  assert.equal(read.state, 'working');
  assert.equal(read.backgroundRunning, true);
  await act(async () => B.putAdapterTasks('other', [task('b')]));
  await act(async () => B.putAdapterTasks('c', [task('a', { status: 'completed' })]));
  assert.equal(read.state, 'idle', "another chat's task is not this one's");
  assert.equal(read.backgroundRunning, false);
  await act(async () => B.putAdapterTasks('c', []));
  session = live({ tasks: [task('m')] });
  await v.rerender(h(Probe, { id: 'c' }));
  assert.equal(read.state, 'working');
  assert.equal(read.backgroundRunning, true);
  session = live({ tasks: [task('m')], turn: 'awaitingUser' });
  await v.rerender(h(Probe, { id: 'c' }));
  assert.equal(read.state, 'approval');
  assert.equal(read.backgroundRunning, true, 'attention cannot hide independent activity');
  B.putAdapterTasks('other', []);
  session = EMPTY_SESSION;
  await v.unmount();
});

test('adapterTasksOf reads the current source only, and the revision moves on every change', async () => {
  let source = 'x';
  B.setAdapterTaskSourceResolver(() => source);
  B.putAdapterTasks('c', [task('a')]);
  assert.deepEqual(
    B.adapterTasksOf('c').map((t) => t.id),
    ['a'],
  );
  source = 'y';
  assert.deepEqual(B.adapterTasksOf('c'), [], "the previous source's tasks are not this chat's now");
  B.putAdapterTasks('c', []);
  B.setAdapterTaskSourceResolver((id) => id);
});

test('a poll that read the same tasks publishes nothing, so readers of every chat do not re-render', async () => {
  let renders = 0;
  function Rev() {
    renders += 1;
    B.useAdapterTasksRevision();
    return null;
  }
  const v = await render(h(Rev));
  const before = renders;
  await act(async () => B.putAdapterTasks('same', [task('a')]));
  const first = B.adapterTasksOf('same');
  await act(async () => B.putAdapterTasks('same', [task('a')]));
  assert.equal(B.adapterTasksOf('same'), first, 'the same tasks keep their list');
  await act(async () => B.putAdapterTasks('none', []));
  assert.equal(renders, before + 1, 'only the first put re-rendered');
  await act(async () => B.putAdapterTasks('same', [task('a', { summary: 'step 2' })]));
  assert.equal(renders, before + 2, 'a changed task publishes');
  B.setAdapterTaskSourceResolver(() => 'other');
  await act(async () => B.putAdapterTasks('same', [task('a', { summary: 'step 2' })]));
  assert.equal(renders, before + 3, 'the same tasks from another source replace the old');
  B.setAdapterTaskSourceResolver((id) => id);
  await act(async () => B.putAdapterTasks('same', []));
  assert.equal(renders, before + 4);
  await v.unmount();
});

test("main's count of a chat's adapter work keeps the row working in a window that never polled it, for the current source only", () => {
  B.setAdapterTaskSourceResolver((id) => JSON.stringify(['codex', id]));
  const work = (key: string, shells = 1, agents = 0) => ({ source: { kind: 'codex' as const, key }, shells, agents });
  assert.equal(state({ session: live({ backgroundWork: work('c') }) }), 'working', 'a background command main counts');
  assert.equal(state({ session: live({ backgroundWork: work('c', 0, 1) }) }), 'working', 'a sub-agent main counts');
  assert.equal(state({ session: live({ backgroundWork: work('old-thread') }) }), 'idle', 'a segment the chat switched away from');
  assert.equal(state({ session: live({ backgroundWork: work('c', 0, 0) }) }), 'idle');
  assert.equal(state({ session: live({ backgroundWork: null }) }), 'idle');
  assert.equal(state({ session: { ...live({}), backgroundWork: undefined } as never }), 'idle', 'a session from before the key');
  // main's count and this window's polled tasks are one set of work: the count is whichever knows more, never the sum
  const s = live({ tasks: [task('claude-job')], backgroundWork: work('c', 1, 1) });
  assert.equal(B.runningTaskCount('c', s, [task('codex-shell:1')]), 3);
  assert.equal(B.runningTaskCount('c', s, [task('a'), task('b'), task('d')]), 4);
  assert.equal(B.runningTaskCount('c', s, [task('a', { status: 'completed' })]), 3);
  B.setAdapterTaskSourceResolver((id) => id);
});
