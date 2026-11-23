// The sidebar at launch (#4655): a project with no chat is "Loading…" while nothing is known of it and the lists have not answered, and leaves the sidebar once it is known to be empty.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { reset, flush, thread, project, mountSidebar, byText } from './support/shell-sidebar-kit.ts';
import { lists } from '../src/store/sidebarSnapshot.ts';

beforeEach(() => {
  lists.setState({ pending: [], known: false });
});

test('a project with no chat says it is loading until a snapshot knew it or all lists answered, then leaves the sidebar', async () => {
  reset({
    savedProjects: [project('p1', '/work/p1', 'Full'), project('p2', '/work/p2', 'Bare')],
    threadOrder: ['c1'],
    threads: { c1: thread('c1', { projectId: 'p1', updatedAt: 5 }) },
    prefs: { sidebarFolders: [], sidebarProjectOrder: ['p1', 'p2'] },
  });
  lists.setState({ pending: ['claude', 'codex'], known: false });
  const view = await mountSidebar();
  await flush();
  const names = () => view.$$('.project-row .side-row-label').map((e) => e.textContent);
  const bare = () => view.$$('.project-group')[1];
  assert.ok(byText(bare(), '.empty-note', 'Loading…'));
  // the project that has a chat never says so
  assert.equal(view.$$('.project-group')[0].querySelector('.empty-note'), null);
  // a snapshot told what the projects hold: Bare is known to be empty, so it is not listed
  lists.setState({ known: true });
  await flush();
  assert.deepEqual(names(), ['Full']);
  // no snapshot: Bare is listed as loading again, and leaves once every list answered
  lists.setState({ known: false, pending: ['codex'] });
  await flush();
  assert.ok(byText(bare(), '.empty-note', 'Loading…'));
  lists.setState({ pending: [] });
  await flush();
  assert.deepEqual(names(), ['Full']);
  await view.unmount();

  // Recents with no chat at all says the same
  reset();
  lists.setState({ pending: ['claude'], known: false });
  const empty = await mountSidebar();
  assert.ok(byText(empty.host, '.empty-note', 'Loading…'));
  lists.setState({ pending: [] });
  await flush();
  assert.ok(byText(empty.host, '.empty-note', 'No chats'));
  await empty.unmount();
});
