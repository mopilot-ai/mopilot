// Project headings stay unmarked while expanded running chat rows retain their activity dot and title shimmer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { Sidebar, reset, render, project, thread } from './support/shell-sidebar-kit.ts';

// Render the real sidebar with a project holding one running chat, collapsed and expanded.
test('project headings have no activity indicator while running chats retain their dot and title shimmer', async () => {
  for (const collapsed of [true, false]) {
    reset({
      savedProjects: [project('project', '/work', 'Sage-Code')],
      threads: { chat: thread('chat', { name: 'Running chat', projectId: 'project', status: { type: 'active' } }) },
      threadOrder: ['chat'],
      collapsedProjects: { project: collapsed },
      runtime: { chat: { activeTurnId: 'running' } },
      prefs: { sidebarFolders: [], sidebarProjectOrder: ['project'] },
    });
    const view = await render(createElement(Sidebar.Sidebar, { width: 280 }));
    const head = view.$('.project-row');
    assert.equal(head.querySelector('.spinner, .row-dot'), null);
    assert.equal(view.host.innerHTML.includes('Project has running chats'), false);
    const groupRows = view.$('.project-group').querySelectorAll('.thread-row .shimmer-text');
    assert.equal(groupRows.length, collapsed ? 0 : 1);
    const dots = view.$('.project-group').querySelectorAll('.thread-row .row-dot.working[aria-label="Working"]');
    assert.equal(dots.length, collapsed ? 0 : 1);
    await view.unmount();
  }
});
