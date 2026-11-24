// Startup submissions are visible in every sidebar organization without becoming actionable or persisted native chats.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import {
  reset,
  getState,
  update,
  project,
  thread,
  mountSidebar,
  probe,
  prefsCalls,
  click,
  byText,
  fx,
} from './support/shell-sidebar-kit.ts';
import { useChatStarts, showChatStart } from '../src/lib/chatStarts.ts';

beforeEach(() => {
  useChatStarts.setState([], true);
  reset({ savedProjects: [project('p', '/work/project', 'Project')], prefs: { sidebarProjectOrder: ['p'] } });
});

test('remembered empty folders keep their order while uncreated submission folders stay transient', async () => {
  reset({ prefs: { sidebarFolders: ['/work/kept'], sidebarProjectOrder: [] } });
  const kept = showChatStart('Kept folder', { cwd: '/work/kept', projectId: null });
  const fresh = showChatStart('New folder', { cwd: '/work/new', projectId: null });
  const { view } = await probe();
  try {
    assert.deepEqual(getState().prefs.sidebarProjectOrder, ['/work/kept']);
    assert.deepEqual(getState().prefs.sidebarFolders, ['/work/kept']);
  } finally {
    await view.unmount();
    kept();
    fresh();
  }
});

for (const list of ['project', 'Projects', 'Recents']) {
  test(`the ${list} list can collapse and reopen while startup remains unresolved`, async () => {
    const view = await mountSidebar();
    let finish!: () => void;
    try {
      await act(async () => {
        finish = showChatStart('Still starting', { cwd: '/work/project', projectId: 'p' });
      });
      const control = () => (list === 'project' ? view.$('.project-row') : byText(view.host, '.side-label', list));
      assert.equal(view.$$('[data-chat-start]').length, 2);
      await click(control());
      assert.equal(view.$$('[data-chat-start]').length, 1, 'collapse must hide this list even during startup');
      await click(control());
      assert.equal(view.$$('[data-chat-start]').length, 2);
      await click(control());
      await act(async () => finish());
      assert.equal(view.$$('[data-chat-start]').length, 0);
      if (list === 'project') assert.equal(getState().collapsedProjects.p, true);
    } finally {
      await view.unmount();
      finish?.();
    }
  });
}

test('pending rows respect collapsed lists and appear when opened, without native chat actions', async () => {
  await update({ ...getState(), collapsedProjects: { p: true } });
  const view = await mountSidebar();
  try {
    await click(byText(view.host, '.side-label', 'Projects'));
    await click(byText(view.host, '.side-label', 'Recents'));
    let finish!: () => void;
    await act(async () => {
      finish = showChatStart('Explain startup', { cwd: '/work/project', projectId: 'p' });
    });
    assert.equal(view.$$('[data-chat-start]').length, 0, 'a submission does not override closed lists');
    await click(byText(view.host, '.side-label', 'Projects'));
    const group = view.$('.project-group');
    assert.equal(group.querySelector('.project-row')!.getAttribute('aria-expanded'), 'false');
    await click(group.querySelector('.project-row')!);
    await click(byText(view.host, '.side-label', 'Recents'));
    assert.equal(group.querySelector('.project-row')!.getAttribute('aria-expanded'), 'true');
    const row = group.querySelector('[data-chat-start]')!;
    assert.equal(row.textContent, 'Explain startup');
    assert.equal(row.getAttribute('aria-busy'), 'true');
    assert.equal(row.querySelector('.row-dot.working')!.getAttribute('aria-label'), 'Starting chat');
    assert.equal(row.querySelector('button'), null);
    assert.equal(row.hasAttribute('data-sidebar-chat'), false);
    assert.equal(group.querySelector('.empty-note'), null);
    assert.equal(view.$$('[data-chat-start]').length, 2, 'project and Recents show the same accepted submission');
    assert.deepEqual(getState().threads, {});
    assert.deepEqual(getState().threadOrder, []);
    // A native refresh cannot erase a submission, and switching project does not move it.
    await update({ ...getState(), newChatProjectId: 'other', threads: { old: thread('old') }, threadOrder: ['old'] });
    assert.equal(view.$$('[data-chat-start]').length, 2);
    await click(group.querySelector('.project-row')!);
    await act(async () => finish());
    assert.equal(view.$$('[data-chat-start]').length, 0);
    assert.deepEqual(getState().collapsedProjects, { p: true }, 'startup does not overwrite a saved collapse choice');
  } finally {
    await view.unmount();
  }
});

test('projectless and attachment-only submissions appear in Recents with no phantom project', async () => {
  reset();
  const view = await mountSidebar();
  try {
    let finish!: () => void;
    await act(async () => {
      finish = showChatStart('', { cwd: '', projectId: null });
    });
    assert.equal(view.$$('[data-chat-start]').length, 1);
    assert.equal(view.$('[data-chat-start] .side-row-label').textContent, 'New chat');
    assert.equal(view.$('.project-group'), null);
    assert.equal(view.$('.empty-note.recents'), null);
    assert.deepEqual(prefsCalls(), []);
    await act(async () => finish());
    assert.equal(view.$('.empty-note.recents').textContent, 'No chats');
  } finally {
    await view.unmount();
  }
});

test('folder-only submissions are grouped immediately but only real chats can persist the folder', async () => {
  reset();
  const { get, view } = await probe();
  try {
    let finish!: () => void;
    await act(async () => {
      finish = showChatStart('Folder task', { cwd: '/work/new-folder', projectId: null });
    });
    assert.equal(get().groups[0].path, '/work/new-folder');
    assert.equal(get().groups[0].starting[0].name, 'Folder task');
    assert.deepEqual(prefsCalls(), []);
    await act(async () => finish());
    assert.deepEqual(get().groups, [], 'failed startup leaves no remembered empty project');
  } finally {
    await view.unmount();
  }
});

test('aliases and independent starts retain captured project membership in project and list views', async () => {
  reset({ savedProjects: [project('alias', '/link', 'Project'), project('real', '/work/project', 'Project')] });
  fx.canonicalPaths = async (paths) => Object.fromEntries(paths.map((p) => [p, p === '/link' ? '/work/project' : p]));
  const view = await mountSidebar();
  try {
    let first!: () => void;
    let second!: () => void;
    await act(async () => {
      first = showChatStart('First', { cwd: '/link', projectId: 'alias' });
      second = showChatStart('Second', { cwd: '/work/project', projectId: 'real' });
    });
    assert.equal(view.$$('.project-group').length, 1);
    assert.equal(view.$('.project-group').querySelectorAll('[data-chat-start]').length, 2);
    await update({ ...getState(), prefs: { ...getState().prefs, sidebarOrganize: 'list' } });
    assert.equal(view.$$('[data-chat-start]').length, 4, 'list and Recents both show independent starts');
    await act(async () => first());
    assert.equal(view.$$('[data-chat-start]').length, 2);
    assert.equal(view.$('[data-chat-start] .side-row-label').textContent, 'Second');
    await act(async () => second());
    assert.equal(view.$$('[data-chat-start]').length, 0);
  } finally {
    await view.unmount();
  }
});

test('a pending submission remains visible when activity view replaces the project lists', async () => {
  const view = await mountSidebar();
  try {
    await update({ ...getState(), activityView: true });
    let finish!: () => void;
    await act(async () => {
      finish = showChatStart('Still starting', { cwd: '/work/project', projectId: 'p' });
    });
    assert.equal(view.$$('[data-chat-start]').length, 1);
    assert.equal(view.$('.empty-note'), null);
    await act(async () => finish());
    assert.equal(view.$('.empty-note').textContent, 'Nothing needs attention');
  } finally {
    await view.unmount();
  }
});

test('sidebar remount retains a pending start; successful startup replaces it with an actionable chat', async () => {
  let finish!: () => void;
  await act(async () => {
    finish = showChatStart('Open me', { cwd: '/work/project', projectId: 'p' });
  });
  const first = await mountSidebar();
  await first.unmount();
  const view = await mountSidebar();
  try {
    assert.equal(view.$$('[data-chat-start]').length, 2);
    await act(async () => {
      await update({ ...getState(), threads: { real: thread('real', { projectId: 'p' }) }, threadOrder: ['real'] });
      finish();
    });
    assert.equal(view.$$('[data-chat-start]').length, 0);
    assert.equal(view.$$('[data-sidebar-chat="real"]').length, 2);
  } finally {
    await view.unmount();
  }
});
