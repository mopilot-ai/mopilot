// src/components/sidebar/Sidebar.tsx: the header controls, adding a project, the resize handle, the selected row, Pinned and
// the activity view, the Projects list's collapse, one-list and sections, and a sidebar dragged to zero width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { STANDALONE_NEW_CHAT_SELECTOR } from './e2e/fixtures/sidebar.ts';
import {
  Sidebar,
  calls,
  fx,
  reset,
  render,
  getState,
  update,
  click,
  key,
  pointer,
  flush,
  thread,
  project,
  named,
  mountSidebar,
  byText,
} from './support/shell-sidebar-kit.ts';

test('header controls start chats, open folders, toggle activity view and search', async () => {
  reset({ pending: [{ threadId: 'x' }] });
  const view = await mountSidebar();
  assert.equal(view.$('.sidebar-scroll .side-row[role=button]')!.getAttribute('aria-label'), 'New chat');
  assert.ok(view.$('.bell-dot'));
  const headerItem = async (text: string) => {
    await click(view.$('.sidebar-title'));
    await click(byText(view.$('[data-menu]'), 'button', text));
    assert.equal(view.$('[data-menu]'), null);
  };
  await headerItem('New chat');
  assert.deepEqual(named('clearNewChatProject'), [[true]]);
  assert.deepEqual(getState().route, { name: 'home' });
  await headerItem('Archived chats');
  assert.deepEqual(getState().route, { name: 'settings', section: 'archived' });
  await headerItem('Settings');
  assert.deepEqual(getState().route, { name: 'settings' });
  // Open folder… with a cancelled dialog does nothing.
  calls.length = 0;
  await headerItem('Open folder…');
  await flush();
  assert.deepEqual(named('navigate'), []);
  await click(view.$('.sidebar-title'));
  await click(view.$('[data-menu] [data-close]'));
  assert.equal(view.$('[data-menu]'), null);

  await click(view.$('[aria-label="Search"]'));
  assert.equal(getState().searchOpen, true);
  await click(view.$('[aria-label="View activity"]'));
  assert.equal(getState().activityView, true);
  assert.equal(view.$('[aria-label="View activity"]').parentElement!.getAttribute('data-tooltip'), 'Turn off activity view');
  assert.ok(view.$('.on-tile'));

  // Quick chat opens the mini window without starting a new chat.
  calls.length = 0;
  await click(view.$('[aria-label="Quick chat"]'));
  assert.deepEqual(named('mini'), [[]]);
  assert.deepEqual(named('navigate'), []);
  // Quick chat is a real button, not one nested inside the New chat button; Enter on it stays its own
  assert.equal(view.$('[aria-label="Quick chat"]').tagName, 'BUTTON');
  assert.equal(view.$('.sidebar-section .side-row').tagName, 'DIV');
  await key(view.$('[aria-label="Quick chat"]'), 'Enter');
  assert.deepEqual(named('navigate'), []);
  await click(view.$('.sidebar-section .side-row'));
  assert.deepEqual(named('clearNewChatProject'), [[true]]);
  // the New chat row is pressed with Enter too
  calls.length = 0;
  await key(view.$('.sidebar-section .side-row'), 'Enter');
  assert.deepEqual(named('clearNewChatProject'), [[true]]);
  await view.unmount();

  reset({ unread: { a: false } });
  const quiet = await mountSidebar();
  assert.equal(quiet.$('.bell-dot'), null);
  assert.equal(quiet.$('[aria-label="View activity"]').parentElement!.getAttribute('data-tooltip'), 'Turn on activity view');
  await update({ ...getState(), unread: { a: true } });
  await flush();
  assert.ok(quiet.$('.bell-dot'));
  await quiet.unmount();
});

test('adding a project creates it and starts a chat there', async () => {
  reset({ prefs: { sidebarFolders: [], sidebarProjectOrder: [] } });
  const view = await mountSidebar();
  fx.openFolder = '/new/folder';
  await click(view.$('[aria-label="Add new project"]'));
  await flush();
  assert.deepEqual(named('createProject'), [['/new/folder']]);
  assert.equal(getState().newChatProjectId, 'p-new');
  assert.deepEqual(getState().route, { name: 'home', cwd: '/new/folder' });
  // Without a created project the chat still opens in the folder.
  calls.length = 0;
  fx.createProject = null;
  await click(byText(view.host, 'button', 'Add a project folder'));
  await flush();
  assert.deepEqual(named('setState'), []);
  assert.deepEqual(named('navigate'), [[{ name: 'home', cwd: '/new/folder' }]]);
  await view.unmount();
});

test('the resize handle drags, cancels, commits and steps with arrow keys', async () => {
  // the handle lives on the frame (src/components/sidebar/SidebarResize.tsx); App gives it the width and saves it
  const { SidebarResize } = await import('../src/components/sidebar/SidebarResize.tsx');
  const { createElement: h, useState, act } = await import('react');
  (window as any).innerWidth = 1400;
  const log: any[][] = [];
  function Frame() {
    const [width, setWidth] = useState(280);
    const [open, setOpen] = useState(true);
    const [dragging, setDragging] = useState(false);
    return h(
      'aside',
      { className: dragging ? 'resizing' : '' },
      h(SidebarResize, {
        open,
        width,
        dragging,
        onWidthChange: (w: number) => {
          log.push(['width', w]);
          setWidth(w);
        },
        onOpenChange: (o: boolean) => {
          log.push(['open', o]);
          setOpen(o);
        },
        onSaveWidth: (w: number) => log.push(['save', w]),
        onDraggingChange: (d: boolean) => {
          log.push(['dragging', d]);
          setDragging(d);
        },
      }),
    );
  }
  const view = await render(h(Frame));
  const of = (name: string) => log.filter((c) => c[0] === name).map((c) => c[1]);
  const handle = view.host.querySelector('.sidebar-resize') as any;
  let captured: number | null = null;
  handle.setPointerCapture = (id: number) => {
    captured = id;
  };
  handle.hasPointerCapture = (id: number) => captured === id;
  handle.releasePointerCapture = () => {
    captured = null;
  };
  assert.equal(handle.getAttribute('aria-valuenow'), '280');

  await pointer(handle, 'pointermove', { clientX: 10 });
  await pointer(handle, 'pointerdown', { button: 2, clientX: 100, pointerId: 1 });
  assert.equal(captured, null);
  assert.deepEqual(of('width'), []);
  await pointer(handle, 'pointerdown', { button: 0, clientX: 100, pointerId: 1 });
  assert.equal(captured, 1);
  assert.match(view.host.querySelector('aside')!.className, /resizing/);
  // a move shows its width on the next animation frame (src/lib/edgeDrag.ts, #2049)
  const frame = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));
  await pointer(handle, 'pointermove', { clientX: 150, pointerId: 1 });
  await frame();
  await pointer(handle, 'pointermove', { clientX: 2000, pointerId: 1 });
  await frame();
  assert.deepEqual(of('width'), [280, 330, 560]);
  await pointer(handle, 'pointerup', { pointerId: 1 });
  assert.equal(captured, null);
  await pointer(handle, 'pointerup', { pointerId: 1 });
  await pointer(handle, 'lostpointercapture', { pointerId: 1 });
  assert.deepEqual(of('save'), [560]);
  assert.doesNotMatch(view.host.querySelector('aside')!.className, /resizing/);
  await pointer(handle, 'lostpointercapture', { pointerId: 1 });
  assert.equal(of('save').length, 1);

  // Cancelling restores the starting width.
  log.length = 0;
  await pointer(handle, 'pointerdown', { button: 0, clientX: 100, pointerId: 2 });
  await pointer(handle, 'pointermove', { clientX: 120, pointerId: 2 });
  await frame();
  await pointer(handle, 'pointercancel', { pointerId: 2 });
  await pointer(handle, 'pointercancel', { pointerId: 2 });
  assert.deepEqual(of('width'), [560, 560, 560]);

  log.length = 0;
  await key(handle, 'ArrowLeft');
  await key(handle, 'ArrowRight');
  await key(handle, 'a');
  assert.deepEqual(of('save'), [550, 560]);
  await view.unmount();
});

test('the selected row follows the route: standalone, project or folder new chat, or an open chat', async () => {
  const groupsState = {
    savedProjects: [project('p1')],
    threadOrder: ['c1', 'c2'],
    threads: { c1: thread('c1', { projectId: 'p1' }), c2: thread('c2', { cwd: '/work/folder' }) },
    prefs: { sidebarFolders: ['/work/folder'], sidebarProjectOrder: ['p1', '/work/folder'] },
  };
  // the top New chat: outside any project, so no project row is the home page's
  reset({ ...groupsState, newChatProjectId: 'none' });
  let view = await mountSidebar();
  assert.match(view.$('.sidebar-section .side-row').className, /selected-soft/);
  assert.equal(view.$('.project-row.selected'), null);
  await view.unmount();

  // nothing picked: the new chat goes to the newest chat's project, and the home page is its row
  reset(groupsState);
  view = await mountSidebar();
  assert.doesNotMatch(view.$('.sidebar-section .side-row').className, /selected-soft/);
  assert.equal(view.$('.project-row.selected .side-row-label')!.textContent, 'p1');
  await view.unmount();

  reset({ ...groupsState, newChatProjectId: null, newChatCwd: '/work/folder' });
  view = await mountSidebar();
  assert.equal(view.$('.project-row.selected .side-row-label')!.textContent, 'folder');
  await view.unmount();

  reset({ ...groupsState, route: { name: 'thread', id: 'c1' } });
  view = await mountSidebar();
  assert.equal(view.$('.project-group .thread-row.selected .side-row-label')!.textContent, 'Chat c1');
  await view.unmount();
});

test('a project row folds and a chat row opens from the keyboard; keys on their own buttons stay theirs', async () => {
  reset({
    savedProjects: [project('p1', '/work/p1')],
    threadOrder: ['c1'],
    threads: { c1: thread('c1', { projectId: 'p1' }) },
    prefs: { sidebarProjectOrder: ['p1'] },
  });
  const view = await mountSidebar();
  const projectRow = view.$('.project-row')!;
  assert.equal(projectRow.getAttribute('aria-label'), 'p1');
  assert.deepEqual(
    [projectRow.getAttribute('role'), projectRow.getAttribute('tabindex'), projectRow.getAttribute('aria-expanded')],
    ['button', '0', 'true'],
  );
  const chatRow = () => view.$('.thread-row')!;
  assert.equal(chatRow().getAttribute('aria-label'), 'Chat c1');
  assert.deepEqual([chatRow().getAttribute('role'), chatRow().getAttribute('tabindex')], ['button', '0']);
  assert.equal(chatRow().getAttribute('aria-current'), null);
  await key(chatRow(), 'Enter');
  assert.deepEqual(named('navigate').at(-1), [{ name: 'thread', id: 'c1' }]);
  assert.equal(chatRow().getAttribute('aria-current'), 'page');
  const opened = named('navigate').length;
  await key(chatRow().querySelector('[aria-label="More options"]')!, 'Enter');
  assert.equal(named('navigate').length, opened, "Enter on the row's menu button does not open the chat");
  await key(projectRow, ' ');
  assert.equal(view.$('.project-row')!.getAttribute('aria-expanded'), 'false');
  await key(view.$('.project-row')!, 'Enter');
  assert.equal(view.$('.project-row')!.getAttribute('aria-expanded'), 'true');
  await view.unmount();
});

test('pinned chats list in manual order, and the activity view shows chats needing attention', async () => {
  reset({
    savedProjects: [project('p1', '/work/p1', 'Proj')],
    threadOrder: ['a', 'b', 'c'],
    threads: {
      a: thread('a', { projectId: 'p1', preview: 'ignored' }),
      b: thread('b', { preview: '**Bold** `code` # head' }),
      c: thread('c'),
      d: thread('d'),
    },
    pinned: { a: true, b: true, c: false, gone: true },
    pending: [{ threadId: 'a' }, { threadId: null }, { threadId: 'gone' }],
    unread: { b: true, c: false, d: true },
    runtime: {
      d: {
        turns: [
          {
            items: [
              { type: 'agentMessage', text: 'Last reply' },
              { type: 'agentMessage', text: '' },
            ],
          },
          { items: [{ type: 'userMessage' }] },
        ],
      },
    },
    route: { name: 'thread', id: 'b' },
    prefs: { chatSort: 'manual', chatOrder: { '@pinned': ['b', 'a'] }, sidebarFolders: [], sidebarProjectOrder: [] },
  });
  const view = await mountSidebar();
  const pinnedSection = byText(view.host, '.side-label', 'Pinned').parentElement!;
  assert.deepEqual(
    [...pinnedSection.querySelectorAll('.thread-row .side-row-label')].map((e) => e.textContent),
    ['Chat b', 'Chat a'],
  );

  await click(view.$('[aria-label="View activity"]'));
  assert.equal(view.$('.side-label') && byText(view.host, '.side-label', 'Priority').textContent, 'Priority');
  assert.equal(view.host.textContent!.includes('Pinned'), false);
  const cards = view.$$('.priority-card');
  assert.deepEqual(
    cards.map((c) => c.querySelector('.priority-title')!.textContent),
    ['Chat a Proj', 'Chat b ', 'Chat d '],
  );
  assert.deepEqual(
    cards.map((c) => c.querySelector('.priority-snippet')!.textContent),
    ['Needs your approval', 'Bold code  head', 'Last reply'],
  );
  assert.match(cards[1].className, /selected/);
  await click(cards[2]);
  assert.deepEqual(getState().route, { name: 'thread', id: 'd' });
  await click(view.$('[aria-label="Mark all as read"]'));
  assert.deepEqual(getState().unread, {});
  await update({ ...getState(), pending: [] });
  await flush();
  assert.ok(byText(view.host, '.empty-note', 'Nothing needs attention'));
  await view.unmount();
});

test('MoMo’s chats are in no sidebar list and light no bell, pinned, unread or waiting on an approval (#2139)', async () => {
  reset({
    threadOrder: ['m', 'a'],
    threads: { m: thread('m'), a: thread('a') },
    momoChats: { m: 'main' },
    pinned: { m: true, a: true },
    pending: [{ threadId: 'm' }],
    unread: { m: true },
    route: { name: 'home' },
    prefs: { sidebarFolders: [], sidebarProjectOrder: [] },
  });
  const view = await mountSidebar();
  const labels = () => view.$$('.thread-row .side-row-label').map((e) => e.textContent);
  assert.ok(!labels().includes('Chat m'));
  assert.ok(labels().includes('Chat a'));
  assert.equal(view.$('.bell-dot'), null);
  await click(view.$('[aria-label="View activity"]'));
  assert.equal(view.$$('.priority-card').length, 0);
  await view.unmount();
});

test('Pinned shows its first 20 chats, then Show more', async () => {
  const threads = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`p${i}`, thread(`p${i}`, { updatedAt: 100 - i })]));
  reset({
    threadOrder: Object.keys(threads),
    threads,
    pinned: Object.fromEntries(Object.keys(threads).map((id) => [id, true])),
    prefs: { sidebarFolders: [], sidebarProjectOrder: [] },
  });
  const view = await mountSidebar();
  const pinnedSection = () => byText(view.host, '.side-label', 'Pinned').parentElement!;
  const rows = () => pinnedSection().querySelectorAll('.thread-row').length;
  assert.equal(rows(), 20);
  await click(byText(pinnedSection(), '.show-more', 'Show 2 more'));
  assert.equal(rows(), 22);
  await click(byText(pinnedSection(), '.show-more', 'Show less'));
  assert.equal(rows(), 20);
  await view.unmount();
});

test('the projects list collapses, switches to one list, and shows sections', async () => {
  const many = Object.fromEntries(
    Array.from({ length: 27 }, (_, i) => [
      `t${i}`,
      thread(`t${i}`, { projectId: i % 2 ? 'p1' : 'p2', updatedAt: 100 - i, recencyAt: i === 3 ? 1000 : undefined }),
    ]),
  );
  reset({
    savedProjects: [project('p1'), project('p2'), project('p3')],
    threadOrder: Object.keys(many),
    threads: many,
    prefs: {
      sidebarSections: [
        { id: 's1', name: 'Work' },
        { id: 's2', name: 'Empty' },
      ],
      projectSection: { p2: 's1', p3: 'gone' },
      sidebarFolders: [],
      sidebarProjectOrder: ['p1', 'p2', 'p3'],
      // p3 has no chat: pinned, it is listed (and leads its block)
      pinnedProjects: ['p3'],
    },
  });
  const view = await mountSidebar();
  // Unsectioned first (including a project mapped to a removed section), then each section, empty ones too.
  const blocks = [...view.$('.side-collapse, .collapse').children] as HTMLElement[];
  assert.deepEqual(
    blocks
      .slice(0, 3)
      .map((b) => [
        b.querySelector('.side-section-label span')?.textContent ?? null,
        [...b.querySelectorAll('.project-row .side-row-label')].map((e) => e.textContent),
      ]),
    [
      [null, ['p3', 'p1']],
      ['Work', ['p2']],
      ['Empty', []],
    ],
  );
  const chevron = byText(view.host, 'button', 'Projects');
  await click(chevron);
  assert.equal(view.$$('.project-row').length, 0);
  assert.match(chevron.querySelector('svg')!.getAttribute('class')!, /rot-90/);
  await click(chevron);
  assert.equal(view.$$('.project-row').length, 3);

  await update({ ...getState(), prefs: { ...getState().prefs, sidebarOrganize: 'list' } });
  await flush();
  assert.equal(view.$$('.project-row').length, 0);
  const projects = () => byText(view.host, 'button', 'Projects').closest('.sidebar-section')!;
  const listRows = () => [...projects().querySelectorAll('.collapse > .sidebar-chat-drag .side-row-label')].map((e) => e.textContent);
  assert.equal(listRows().length, 20);
  assert.equal(listRows()[0], 'Chat t3');
  await click(byText(view.host, '.show-more.recents', 'Show 5 more'));
  assert.equal(listRows().length, 25);
  await click(byText(view.host, '.show-more.recents', 'Show 2 more'));
  assert.equal(listRows().length, 27);
  await click(byText(view.host, '.show-more.recents', 'Show less'));
  assert.equal(listRows().length, 20);
  await update({ ...getState(), prefs: { ...getState().prefs, chatSort: 'manual', chatOrder: { '@list': ['t16', 't3'] } } });
  await flush();
  assert.deepEqual(listRows().slice(0, 3), ['Chat t0', 'Chat t1', 'Chat t2']);
  assert.equal(listRows().includes('Chat t16'), false);
  await view.unmount();
});

test('a sidebar dragged to zero width hides its contents until it is widened again', async () => {
  reset({});
  const shown = await mountSidebar();
  try {
    assert.equal(shown.$('aside.thread-sidebar').classList.contains('drag-hidden'), false);
  } finally {
    await shown.unmount();
  }
  const hidden = await render(h(Sidebar.Sidebar, { width: 0, onWidthChange: (() => {}) as any } as any));
  try {
    assert.equal(hidden.$('aside.thread-sidebar').classList.contains('drag-hidden'), true);
  } finally {
    await hidden.unmount();
  }
});

test('the E2E standalone New chat locator selects only the primary row alongside Recents and projects', async () => {
  reset({ savedProjects: [project('p1')] });
  const view = await mountSidebar();
  assert.equal(view.host.querySelectorAll('button[aria-label="New chat"], [role="button"][aria-label="New chat"]').length, 2);
  const matches = view.host.querySelectorAll(STANDALONE_NEW_CHAT_SELECTOR);
  assert.equal(matches.length, 1);
  await click(matches[0]);
  assert.deepEqual(named('clearNewChatProject'), [[true]]);
  assert.deepEqual(getState().route, { name: 'home' });
  await view.unmount();
});

test('the new-chat row hint follows rebinding and removal', async () => {
  reset();
  const view = await mountSidebar();
  await update({ ...getState(), prefs: { ...getState().prefs, keybindings: { 'new-chat': '⇧⌘Y' } } });
  assert.equal(view.$('.side-row-kbd')!.textContent, '⇧⌘Y');
  await update({ ...getState(), prefs: { ...getState().prefs, keybindings: { 'new-chat': null } } });
  assert.equal(view.$('.side-row-kbd')!.textContent, '');
  await view.unmount();
});
