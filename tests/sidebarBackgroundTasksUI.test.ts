// The sidebar with background tasks (src/components/sidebar/ThreadIndicators.tsx, ThreadRow.tsx, ChildRows.tsx): a chat
// whose turn ended keeps its working dot and shimmering name while a task runs, and a hidden nested session with one
// counts as working in its parent's summary, on every harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset, fx, thread, mountSidebar, flush, update, getState, click } from './support/shell-sidebar-kit.ts';

const { resetSideSessions } = await import('../src/lib/sideSessions.ts');
const { resetNestedHidden } = await import('../src/lib/nestedHidden.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
const B = await import('../src/store/backgroundTasks.ts');
const { act } = await import('react');
markWindowReady();

const task = (id: string, o: object = {}): any => ({ id, type: 'local_agent', description: id, status: 'running', ambient: false, ...o });
const rowOf = (host: HTMLElement, id: string) => host.querySelector(`[data-sidebar-chat="${id}"]`) as HTMLElement | null;
const child = (parentId: string, createdAt: number) => ({
  parentId,
  name: `n${createdAt}`,
  title: `n${createdAt}`,
  harness: null,
  useWorktree: false,
  createdAt,
  lastReport: null,
});

function fresh(ids: string[], over: Record<string, any> = {}) {
  localStorage.clear();
  resetNestedHidden();
  resetSideSessions();
  const threads = Object.fromEntries(ids.map((id, i) => [id, thread(id, { cwd: '/home', updatedAt: 50 - i })]));
  reset({ threadOrder: ids, threads, prefs: { sidebarFolders: [], sidebarProjectOrder: [] }, ...over });
}

test("a row whose turn ended keeps its working state while main's or an adapter's task runs", async () => {
  fresh(['claude', 'codex', 'acp:gemini:chat', 'done'], {
    sessions: {
      claude: { rev: 1, turn: 'idle', approvals: [], tasks: [task('a')] },
      done: { rev: 1, turn: 'idle', approvals: [], tasks: [task('b', { status: 'completed' })] },
    },
  });
  await act(async () => B.putAdapterTasks('codex', [task('c')]));
  await act(async () => B.putAdapterTasks('acp:gemini:chat', [task('d')]));
  const view = await mountSidebar();
  await flush();
  for (const id of ['claude', 'codex', 'acp:gemini:chat']) {
    const row = rowOf(view.host, id)!;
    assert.equal(row.querySelector('[role="img"][aria-label="Working"]')?.getAttribute('aria-label'), 'Working', id);
    assert.ok(row.querySelector('.row-status .row-dot.working'), `${id}: background work keeps a visible dot`);
    assert.ok(row.querySelector('.shimmer-text'), `${id}: its name shimmers as a working row's does`);
  }
  assert.equal(rowOf(view.host, 'done')!.querySelector('.row-dot'), null, 'settled tasks leave the row idle');
  // the task settles: the dot goes
  await act(async () => B.putAdapterTasks('codex', [task('c', { status: 'completed' })]));
  assert.equal(rowOf(view.host, 'codex')!.querySelector('.row-dot'), null);
  await act(async () => B.putAdapterTasks('codex', []));
  await act(async () => B.putAdapterTasks('acp:gemini:chat', []));
  await view.unmount();
});

test("a hidden nested session with a running task counts as working in its parent's summary, and stops when it settles", async () => {
  fresh(['top', 'k1', 'k2'], { sessions: { k1: { rev: 1, turn: 'idle', approvals: [], tasks: [task('a')] } } });
  fx.orchestration = { children: { k1: child('top', 1), k2: child('top', 2) }, deliveries: {}, proposals: {}, queue: [] };
  const view = await mountSidebar();
  await flush();
  await click(rowOf(view.host, 'top')!.querySelector('.nested-caret[aria-expanded]')!);
  const summary = () => (view.host.querySelector('.nested-summary') as HTMLElement).getAttribute('aria-label');
  assert.equal(summary(), 'Show 2 nested sessions, 1 working');
  // an adapter's task on the other one counts the same; its change re-renders the summary
  await act(async () => B.putAdapterTasks('k2', [task('b')]));
  assert.equal(summary(), 'Show 2 nested sessions, 2 working');
  await act(async () => B.putAdapterTasks('k2', []));
  await update({ ...getState(), sessions: {} });
  assert.equal(summary(), 'Show 2 nested sessions');
  await view.unmount();
});

for (const id of ['claude', 'codex', 'acp:gemini:chat']) {
  test(`${id}: activity pulses until the last job finishes, even while approval, input or an error needs attention`, async () => {
    fresh([id]);
    const view = await mountSidebar();
    const row = () => rowOf(view.host, id)!;
    const activity = () => row().querySelector('.row-status .row-dot.working');
    const patch = (over: object) =>
      update({ ...getState(), sessions: { [id]: { rev: 1, turn: 'idle', approvals: [], tasks: [], ...over } } });
    const work = [task('shell', { type: 'local_bash' }), task('agent')];
    try {
      await flush();
      await patch({ turn: 'running' });
      assert.ok(activity(), 'LLM work pulses before a background job starts');
      await patch({ tasks: work });
      assert.ok(activity(), 'the LLM reply finishing does not end background activity');
      await patch({ turn: 'awaitingUser', tasks: work });
      assert.equal(activity()?.getAttribute('aria-label'), 'Awaiting approval · Background tasks running');
      await patch({ tasks: work, questions: [{ status: 'pending' }] });
      assert.equal(activity()?.getAttribute('aria-label'), 'Needs input · Background tasks running');
      await patch({ turn: 'crashed', tasks: work });
      assert.equal(activity()?.getAttribute('aria-label'), 'Working · chat failed · open chat to retry');
      await patch({ turn: 'crashed' });
      assert.equal(activity(), null);
      assert.ok(row().querySelector('[aria-label="Chat failed"]'), 'the failure remains when background work ends');
      await patch({ turn: 'awaitingUser' });
      assert.ok(row().querySelector('.row-dot.waiting[aria-label="Awaiting approval"]'));
      await patch({ questions: [{ status: 'pending' }] });
      assert.ok(row().querySelector('.row-dot.waiting[aria-label="Needs input"]'));
      await patch({ tasks: [task('shell', { status: 'completed' }), task('agent')] });
      assert.ok(activity(), 'one finished job cannot clear another running job');
      await patch({ tasks: work.map((t) => ({ ...t, status: 'completed' })) });
      assert.equal(row().querySelector('.row-dot'), null, 'all work finished and read leaves an empty status slot');
      assert.ok(row().querySelector('.row-status'), 'the empty slot still anchors the PR column');
    } finally {
      await view.unmount();
    }
  });
}
