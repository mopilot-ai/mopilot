// Sidebar default folds keep open and working chats visible through src/components/sidebar/useRequiredChats.ts, including their family heads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { reset, fx, thread, mountSidebar, flush, update, getState, click, named } from './support/shell-sidebar-kit.ts';

const { resetSideSessions } = await import('../src/lib/sideSessions.ts');
const { resetNestedHidden } = await import('../src/lib/nestedHidden.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
const { putAdapterTasks } = await import('../src/store/backgroundTasks.ts');
markWindowReady();

type View = 'project' | 'list' | 'recents';
function fresh(mode: View, prefix = 'codex') {
  localStorage.clear();
  resetSideSessions();
  resetNestedHidden();
  const ids = Array.from({ length: 35 }, (_, i) => `${prefix}-${i}`);
  const threads = Object.fromEntries(
    ids.map((id, i) => [id, thread(id, { cwd: mode === 'recents' ? '/home' : '/work/a', updatedAt: 100 - i })]),
  );
  reset({
    threads,
    threadOrder: ids,
    prefs: { sidebarFolders: [], sidebarProjectOrder: [], sidebarOrganize: mode === 'list' ? 'list' : 'project' },
  });
  return ids;
}
function scope(host: HTMLElement, mode: View) {
  if (mode === 'project') return host.querySelector('.project-group')!;
  return [...host.querySelectorAll('.sidebar-section')].find(
    (section) => section.querySelector('.side-label')?.textContent === (mode === 'recents' ? 'Recents' : 'Projects'),
  )!;
}
const shown = (scope: Element) => [...scope.querySelectorAll('[data-sidebar-chat]')].map((row) => row.getAttribute('data-sidebar-chat'));

for (const mode of ['project', 'list', 'recents'] as const) {
  for (const harness of ['codex', 'claude', 'acp:gemini']) {
    test(`${mode}/${harness}: all running sessions extend the default fold, then completion releases it`, async () => {
      const ids = fresh(mode, harness);
      const first = mode === 'list' ? 20 : 5;
      const view = await mountSidebar();
      try {
        await flush();
        const list = scope(view.host, mode);
        assert.deepEqual(shown(list), ids.slice(0, first));
        assert.ok(
          named('ensureSession').some(([id]) => id === ids[first + 5]),
          'hidden chats load their main-owned state',
        );
        await update({
          ...getState(),
          route: { name: 'thread', id: ids[1] },
          sessions: {
            [ids[first + 1]]: { rev: 1, turn: 'running' },
            [ids[first + 5]]: { rev: 1, turn: 'running' },
          },
        });
        assert.deepEqual(shown(list), ids.slice(0, first + 6), 'the first selected/running row cannot hide later running rows');
        assert.equal(list.querySelector('.selected')?.getAttribute('data-sidebar-chat'), ids[1]);
        await update({ ...getState(), sessions: { [ids[first + 1]]: { rev: 2, turn: 'running' } } });
        assert.deepEqual(shown(list), ids.slice(0, first + 2));
        await update({ ...getState(), sessions: {} });
        assert.deepEqual(shown(list), ids.slice(0, first));
      } finally {
        await view.unmount();
      }
    });
  }

  test(`${mode}: an open or working nested chat brings its family above the default fold`, async () => {
    const ids = fresh(mode);
    const at = mode === 'list' ? 23 : 8;
    const kid = 'claude-nested';
    const grand = 'acp:gemini:grandchild';
    const cwd = getState().threads[ids[at]].cwd;
    await update({
      ...getState(),
      threadOrder: [...ids, kid, grand],
      threads: { ...getState().threads, [kid]: thread(kid, { cwd, updatedAt: 1 }), [grand]: thread(grand, { cwd, updatedAt: 0 }) },
      route: { name: 'thread', id: grand },
    });
    const link = (parentId: string) => ({ parentId, name: 'child', title: 'Child', harness: null, useWorktree: false, createdAt: 1 });
    fx.orchestration = { children: { [kid]: link(ids[at]), [grand]: link(kid) }, deliveries: {}, proposals: {}, queue: [] };
    const view = await mountSidebar();
    try {
      await flush();
      const list = scope(view.host, mode);
      const expected = [...ids.slice(0, at + 1), kid, grand];
      assert.deepEqual(shown(list), expected);
      assert.equal(list.querySelector('.selected')?.getAttribute('data-sidebar-chat'), grand);
      await update({ ...getState(), route: { name: 'home' }, sessions: { [grand]: { rev: 1, turn: 'running' } } });
      assert.deepEqual(shown(list), expected, 'a running descendant keeps its otherwise idle family visible');
      await update({ ...getState(), sessions: { [grand]: { rev: 2, turn: 'idle' } } });
      assert.deepEqual(shown(list), ids.slice(0, mode === 'list' ? 20 : 5));
    } finally {
      await view.unmount();
    }
  });
}

test('Show more and Show less retain running chats without expanding their duplicate Recents or Pinned lists', async () => {
  const ids = fresh('project');
  await update({
    ...getState(),
    sessions: { [ids[8]]: { rev: 1, turn: 'running' } },
    pinned: Object.fromEntries(ids.map((id) => [id, true])),
  });
  const view = await mountSidebar();
  try {
    await flush();
    const list = scope(view.host, 'project');
    assert.deepEqual(shown(list), ids.slice(0, 9));
    assert.deepEqual(shown(scope(view.host, 'recents')), ids.slice(0, 5));
    const pinned = [...view.host.querySelectorAll('.sidebar-section')].find(
      (s) => s.querySelector('.side-label')?.textContent === 'Pinned',
    )!;
    assert.equal(shown(pinned).length, 20);
    while (list.querySelector('.show-more')?.textContent !== 'Show less') await click(list.querySelector('.show-more')!);
    assert.deepEqual(shown(list), ids);
    await click(list.querySelector('.show-more')!);
    assert.deepEqual(shown(list), ids.slice(0, 9));
    await update({ ...getState(), sessions: { [ids[33]]: { rev: 1, turn: 'running' } }, revealedChats: { '/work/a': 30 } });
    assert.equal(list.querySelector('.show-more')?.getAttribute('aria-disabled'), 'true');
    assert.match(list.querySelector('.show-more')?.getAttribute('title') ?? '', /open or active/);
  } finally {
    await view.unmount();
  }
});

test('folds follow the row status for background work, requests, external runs and authoritative completion', async () => {
  const ids = fresh('recents');
  const id = ids[9];
  const view = await mountSidebar();
  const task = {
    id: 'task',
    type: 'local_bash',
    description: 'Server',
    status: 'running',
    summary: null,
    toolUseId: null,
    subagentType: null,
    workflowName: null,
    parentTaskId: null,
    ambient: false,
    startedAt: 1,
  };
  try {
    await flush();
    const list = scope(view.host, 'recents');
    const initial = getState();
    for (const patch of [
      { sessions: { [id]: { rev: 1, turn: 'idle', tasks: [task] } } },
      { sessions: { [id]: { rev: 1, turn: 'crashed', tasks: [task] } } },
      { sessions: { [id]: { rev: 1, turn: 'awaitingUser' } } },
      { sessions: { [id]: { rev: 1, turn: 'idle', questions: [{ status: 'pending' }] } } },
      { sessions: { [id]: { rev: 1, turn: 'idle', runningElsewhere: true } } },
      { elsewhere: { [id]: { app: 'claude-desktop', running: true } } },
      { runtime: { [id]: { activeTurnId: 'turn' } } },
      { pending: [{ threadId: id, method: 'acp/permission' }] },
      { pending: [{ threadId: id, method: 'item/tool/requestUserInput' }] },
      { threads: { ...initial.threads, [id]: { ...initial.threads[id], status: { type: 'active' } } } },
    ]) {
      await update({ ...initial, ...patch });
      assert.deepEqual(shown(list), ids.slice(0, 10));
      await update(initial);
      assert.deepEqual(shown(list), ids.slice(0, 5));
    }
    await act(async () => putAdapterTasks(id, [task]));
    assert.deepEqual(shown(list), ids.slice(0, 10));
    await act(async () => putAdapterTasks(id, []));
    assert.deepEqual(shown(list), ids.slice(0, 5));
    await update({
      ...initial,
      threads: { ...initial.threads, [id]: { ...initial.threads[id], status: { type: 'active' } } },
      runtime: { [id]: { activeTurnId: 'stale' } },
      sessions: { [id]: { rev: 2, turn: 'idle' } },
    });
    assert.deepEqual(shown(list), ids.slice(0, 5), 'main completion supersedes stale native and renderer activity');
  } finally {
    await act(async () => putAdapterTasks(id, []));
    await view.unmount();
  }
});

test('manual ordering and open split panes set the floor, while explicit project collapse remains respected', async () => {
  const ids = fresh('project');
  const order = [...ids].reverse();
  await update({
    ...getState(),
    prefs: { ...getState().prefs, chatSort: 'manual', chatOrder: { '/work/a': order } },
    route: { name: 'thread', id: order[1] },
    split: { panes: [{ chatId: order[9], weight: 1 }], focus: 'primary', primaryWeight: 1 },
  });
  const view = await mountSidebar();
  try {
    await flush();
    const list = scope(view.host, 'project');
    assert.deepEqual(shown(list), order.slice(0, 10));
    await click(list.querySelector('.project-row')!);
    assert.deepEqual(shown(list), []);
    await click(list.querySelector('.project-row')!);
    assert.deepEqual(shown(list), order.slice(0, 10));
    await update({ ...getState(), split: { panes: [], focus: 'primary', primaryWeight: 1 } });
    assert.deepEqual(shown(list), order.slice(0, 5));
  } finally {
    await view.unmount();
  }
});
