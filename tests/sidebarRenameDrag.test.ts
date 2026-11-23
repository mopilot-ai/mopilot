// src/lib/rowDrag.ts in src/components/sidebar/ThreadRow.tsx and ProjectGroup.tsx: a row being renamed doesn't drag, so a
// mouse drag in its name field selects text instead of moving the chat or project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reset, click, mouse, blur, focus, thread, project, mountSidebar, byText } from './support/shell-sidebar-kit.ts';

test('chat and project rows stop dragging while their rename field has focus', async () => {
  reset({
    savedProjects: [project('p1', '/work/p1', 'Proj')],
    threadOrder: ['a'],
    threads: { a: thread('a', { projectId: 'p1', name: 'Chat A' }) },
    prefs: { sidebarFolders: [], sidebarProjectOrder: ['p1'] },
  });
  const view = await mountSidebar();
  const chatDrag = () => view.$('.thread-row').closest('.sidebar-chat-drag')!;

  // a chat row: draggable until its rename field takes focus, and again once the field leaves
  assert.equal(chatDrag().getAttribute('draggable'), 'true');
  await mouse(view.$('.thread-row'), 'dblclick');
  const input = view.$('.thread-row .rename-input');
  await focus(input);
  assert.equal(chatDrag().getAttribute('draggable'), 'false');
  await blur(input);
  assert.equal(chatDrag().getAttribute('draggable'), 'true');

  // focus on the row itself (a button, not a text field) keeps it draggable
  await focus(view.$('.thread-row'));
  assert.equal(chatDrag().getAttribute('draggable'), 'true');

  // a project row the same way
  const row = byText(view.host, '.project-row .side-row-label', 'Proj').closest('.project-row')!;
  const projectRow = () => row;
  assert.equal(projectRow().getAttribute('draggable'), 'true');
  await mouse(projectRow(), 'contextmenu');
  await click(byText(view.$('[data-menu]'), 'button', 'Edit'));
  const field = projectRow().querySelector('.rename-input')!;
  await focus(field);
  assert.equal(projectRow().getAttribute('draggable'), 'false');
  await blur(field);
  assert.equal(projectRow().getAttribute('draggable'), 'true');
  await view.unmount();
});
