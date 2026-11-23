// Sidebar families use one visual level and preserve attention/open rows when collapsed across harnesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { Thread } from '../src/store/types';
import {
  reset,
  fx,
  thread,
  mountSidebar,
  flush,
  click,
  update,
  getState,
  named,
  byText,
  render,
  key,
  blur,
} from './support/shell-sidebar-kit.ts';

const { resetSideSessions } = await import('../src/lib/sideSessions.ts');
const { resetNestedHidden } = await import('../src/lib/nestedHidden.ts');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

test('families follow the most active member, flatten grandchildren and retain attention when collapsed', async () => {
  localStorage.clear();
  resetNestedHidden();
  resetSideSessions();
  const ids = ['parent', 'child', 'grand', 'other', 'waiting'];
  const threads = Object.fromEntries(
    ids.map((id) => [id, thread(id, { cwd: '/home', updatedAt: id === 'grand' ? 100 : id === 'other' ? 50 : 1 })]),
  );
  reset({
    threadOrder: ids,
    threads,
    pending: [{ threadId: 'waiting', method: 'item/tool/requestUserInput' }],
    prefs: { sidebarFolders: [], sidebarProjectOrder: [] },
  });
  const child = (parentId: string) => ({
    parentId,
    name: 'worker',
    title: 'Worker',
    createdAt: 1,
    useWorktree: false,
    harness: 'claude',
    lastReport: null,
  });
  fx.orchestration = {
    children: { child: child('parent'), grand: child('child'), waiting: child('parent') },
    queue: [],
    deliveries: {},
    proposals: {},
  };
  const view = await mountSidebar();
  await flush();
  try {
    const rows = () => [...view.host.querySelectorAll('.thread-row')];
    assert.deepEqual(
      rows().map((r) => r.getAttribute('data-sidebar-chat')),
      ['parent', 'child', 'grand', 'waiting', 'other'],
    );
    assert.equal(view.host.querySelectorAll('.side-children').length, 1, 'one connector container for the family');
    assert.ok(
      rows()
        .slice(1, 4)
        .every((r) => (r as HTMLElement).style.getPropertyValue('--depth') === '1'),
    );
    const toggle = view.host.querySelector('.nested-caret')!;
    assert.ok(toggle, 'the caret sits beside the title, outside hover controls');
    assert.equal(toggle.closest('.row-actions'), null);
    await click(view.host.querySelector('[data-sidebar-chat="parent"] [aria-label="More options"]')!);
    const menu = view.host.querySelector('.row-menu')!;
    await key(menu, 'ArrowDown');
    assert.equal(getState().route.name, 'home', 'menu keys do not activate the owning chat row');
    await click(view.host.querySelector('[data-menu] [data-close]')!);
    await click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'the persistent caret owns family folding');
    await click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    await click(toggle);
    assert.deepEqual(
      rows().map((r) => r.getAttribute('data-sidebar-chat')),
      ['parent', 'waiting', 'other'],
    );
    assert.equal(view.host.querySelector('.nested-summary')?.textContent, '2 more nested sessions');
    await update({ ...getState(), route: { name: 'thread', id: 'grand' } });
    assert.deepEqual(
      rows().map((r) => r.getAttribute('data-sidebar-chat')),
      ['parent', 'grand', 'waiting', 'other'],
    );
    await click(view.host.querySelector('[data-sidebar-chat="parent"] [aria-label="More options"]')!);
    await click(byText(view.host, '[data-menu] [data-item]', 'Rename'));
    const rename = view.host.querySelector('[data-sidebar-chat="parent"] input') as HTMLInputElement;
    rename.value = 'Renamed family';
    await blur(rename);
    assert.deepEqual(named('renameThread').at(-1), ['parent', 'Renamed family']);
  } finally {
    await view.unmount();
  }
});

test('a stale family view whose parent left the list draws no orphaned guide or child', async () => {
  resetSideSessions();
  reset({ threads: { child: thread('child') }, threadOrder: ['child'] });
  fx.orchestration = { children: { child: { parentId: 'missing', createdAt: 1 } }, queue: [], deliveries: {}, proposals: {} };
  const { ChildRows } = await import('../src/components/sidebar/ChildRows.tsx');
  const view = await render(createElement(ChildRows, { parentId: 'missing', activeThread: null, view: 'recents' }));
  await flush();
  assert.equal(view.host.querySelector('.side-children'), null);
  await view.unmount();
});

test('private MoMo chats affect neither family rank nor children/caret, while user workers started by MoMo remain listed', async () => {
  resetSideSessions();
  const updates = { parent: 1, other: 50, privateChild: 100, momoParent: 120, userWorker: 20 };
  const threads = Object.fromEntries(Object.entries(updates).map(([id, updatedAt]) => [id, thread(id, { cwd: '/repo', updatedAt })]));
  reset({
    threads,
    threadOrder: Object.keys(threads),
    momoChats: { privateChild: 'previous', momoParent: 'main' },
    prefs: { sidebarOrganize: 'list', sidebarFolders: [], sidebarProjectOrder: [] },
  });
  const child = (parentId: string) => ({
    parentId,
    name: 'worker',
    title: 'Worker',
    createdAt: 1,
    useWorktree: false,
    harness: 'claude',
    lastReport: null,
  });
  fx.orchestration = {
    children: { privateChild: child('parent'), userWorker: child('momoParent') },
    queue: [],
    deliveries: {},
    proposals: {},
  };
  const { OneList } = await import('../src/components/sidebar/ChatLists.tsx');
  const view = await render(
    createElement(OneList, {
      groups: [
        {
          id: null,
          path: '/repo',
          name: 'Repo',
          saved: false,
          threads: ['parent', 'other', 'userWorker'].map((id) => threads[id] as Thread),
        },
      ],
      activeThread: null,
      reorderChat: () => {},
    }),
  );
  await flush();
  try {
    const rows = [...view.host.querySelectorAll('.thread-row')];
    assert.deepEqual(
      rows.map((row) => row.getAttribute('data-sidebar-chat')),
      ['other', 'userWorker', 'parent'],
    );
    assert.equal(view.host.querySelector('[data-sidebar-chat="parent"] .nested-caret'), null, 'no caret for a hidden private child');
    assert.equal(view.host.querySelector('.side-children'), null, 'private MoMo descendants never enter a user family');
  } finally {
    await view.unmount();
  }
});

test('bulk fold ignores private MoMo parent and child families', async () => {
  resetSideSessions();
  reset({
    threadOrder: ['parent', 'privateChild', 'momoParent', 'userWorker'],
    momoChats: { privateChild: 'previous', momoParent: 'main' },
  });
  const child = (parentId: string) => ({
    parentId,
    name: 'worker',
    title: 'Worker',
    createdAt: 1,
    useWorktree: false,
    harness: 'claude',
    lastReport: null,
  });
  fx.orchestration = {
    children: { privateChild: child('parent'), userWorker: child('momoParent') },
    queue: [],
    deliveries: {},
    proposals: {},
  };
  const { NestedAllItem } = await import('../src/components/sidebar/ChildRows.tsx');
  const view = await render(createElement(NestedAllItem, { parents: ['parent', 'momoParent'], view: 'list' }));
  await flush();
  assert.equal(view.host.textContent, '');
  await view.unmount();
});
