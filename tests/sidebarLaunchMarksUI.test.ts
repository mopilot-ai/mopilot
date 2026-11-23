// The sidebar's launch marks (#4655): the first frame of the sidebar and the first frame with chats in a project, each marked once.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reset, update, getState, flush, thread, project, mountSidebar } from './support/shell-sidebar-kit.ts';
import { LAUNCH_PREFIX, resetLaunchMarks } from '../src/lib/launchMarks.ts';
import { lists } from '../src/store/sidebarSnapshot.ts';

const marks = () => performance.getEntriesByType('mark').filter((m) => m.name.startsWith(LAUNCH_PREFIX));
beforeEach(() => {
  performance.clearMarks();
  resetLaunchMarks();
});
afterEach(() => {
  lists.setState({ pending: [], known: false });
});

test('the first frame of the sidebar and the first frame with chats in a project are marked, once', async () => {
  reset({ savedProjects: [project('p1', '/work/p1', 'Full')], prefs: { sidebarFolders: [], sidebarProjectOrder: ['p1'] } });
  // a cold launch: the lists have not answered, so the project with no chat yet is drawn as loading
  lists.setState({ pending: ['codex'], known: false });
  const view = await mountSidebar();
  await flush();
  assert.deepEqual(
    marks().map((m) => [m.name, (m as PerformanceMark).detail]),
    [['mopilot:sidebar:firstFrame', 1]],
  );
  await update({ ...getState(), threadOrder: ['c1'], threads: { c1: thread('c1', { projectId: 'p1', updatedAt: 5 }) } });
  await flush();
  await update({
    ...getState(),
    threadOrder: ['c1', 'c2'],
    threads: { ...getState().threads, c2: thread('c2', { projectId: 'p1', updatedAt: 6 }) },
  });
  await flush();
  assert.deepEqual(
    marks().map((m) => [m.name, (m as PerformanceMark).detail]),
    [
      ['mopilot:sidebar:firstFrame', 1],
      ['mopilot:sidebar:firstChats', 1],
    ],
  );
  await view.unmount();
});
