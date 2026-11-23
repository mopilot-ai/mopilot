import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { popoverExports, render, click, byText, type } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
let groups: any[] = [];
let folder: string | null = null;
let confirmAnswer = false;
let deleteError: Error | null = null;
(globalThis as any).confirm = (msg: string) => (calls.push(['confirm', msg]), confirmAnswer);

stubStore({
  navigate: (r: any) => calls.push(['navigate', r]),
  setState: (p: any) => calls.push(['setState', typeof p === 'function' ? p({}) : p]),
  createProject: async (p: string) => calls.push(['create', p]),
  deleteProject: async (id: string) => {
    calls.push(['delete', id]);
    if (deleteError) throw deleteError;
  },
  toastFailure: (what: string) => (error: Error) => calls.push(['toast', what, error.message]),
});
installNativeStub({ dialog: { openFolder: async () => folder } });
mock.module('../src/session/open.ts', { namedExports: { showInFinder: (p: string) => calls.push(['showInFinder', p]) } });
mock.module('../src/components/sidebar/Sidebar.tsx', { namedExports: { useProjectGroups: () => ({ groups }) } });
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
mock.module('../src/lib/format.ts', { namedExports: { relativeTime: (t: number) => `t${t}` } });
const { Projects } = await import('../src/components/pages/Projects.tsx');

const names = (host: HTMLElement) => [...host.querySelectorAll('.settings-row-title')].map((e) => e.textContent);

test('empty states for no projects and no match', async () => {
  groups = [{ id: 'x', name: 'unsaved', saved: false, path: '/x', threads: [] }];
  const v = await render(h(Projects));
  assert.equal(v.host.querySelector('.empty-state')!.textContent, 'No projects yet');
  groups = [{ id: 'a', name: 'Alpha', saved: true, path: '/a', threads: [] }];
  await v.rerender(h(Projects));
  await type(v.host.querySelector('input'), 'zzz');
  assert.equal(v.host.querySelector('.empty-state')!.textContent, 'No matching projects');
  await v.unmount();
});

test('saved projects sort by newest activity, filter by name, and show chat counts', async () => {
  groups = [
    { id: 'a', name: 'Alpha', saved: true, path: '/p/alpha', threads: [{ updatedAt: 5 }] },
    { id: 'b', name: 'Beta', saved: true, path: '/p/beta', threads: [{ updatedAt: 1, recencyAt: 50 }, { updatedAt: 9 }] },
    { id: 'c', name: 'Gamma', saved: true, path: '/p/gamma', threads: [] },
  ];
  const v = await render(h(Projects));
  assert.deepEqual(names(v.host), ['Beta', 'Alpha', 'Gamma']);
  const values = [...v.host.querySelectorAll('.settings-value')].map((e) => e.textContent);
  assert.deepEqual(values, ['2 chats · t50', '1 chat · t5', '0 chats']);
  await type(v.host.querySelector('input'), 'ALP');
  assert.deepEqual(names(v.host), ['Alpha']);
  await v.unmount();
});

test('removing a combined project row forwards every saved alias', async () => {
  groups = [{ id: 'a', projectIds: ['a', 'alias'], name: 'Alpha', saved: true, path: '/a', threads: [] }];
  confirmAnswer = true;
  const v = await render(h(Projects));
  calls.length = 0;
  await click(v.host.querySelector('[aria-label="Project actions"]'));
  await click(byText(v.host, 'Remove project'));
  assert.deepEqual(
    calls.filter(([name]) => name === 'delete'),
    [
      ['delete', 'a'],
      ['delete', 'alias'],
    ],
  );
  await v.unmount();
});

test('new project adds the chosen folder, and nothing when cancelled', async () => {
  groups = [];
  const v = await render(h(Projects));
  calls.length = 0;
  folder = null;
  await click(byText(v.host, 'New project'));
  assert.deepEqual(calls, []);
  folder = '/new/dir';
  await click(byText(v.host, 'New project'));
  assert.deepEqual(calls, [['create', '/new/dir']]);
  await v.unmount();
});

test('a row opens a new chat there; its menu opens Finder and removes after confirming', async () => {
  groups = [{ id: 'a', name: 'Alpha', saved: true, path: '/p/alpha', threads: [] }];
  const v = await render(h(Projects));
  calls.length = 0;
  await click(v.host.querySelector('.project-row'));
  assert.deepEqual(calls, [
    ['setState', { newChatProjectId: 'a', newChatCwd: null }],
    ['navigate', { name: 'home', cwd: '/p/alpha' }],
  ]);
  // the row is pressed with Enter too; Enter on its actions button is the button's, not the row's
  calls.length = 0;
  const enter = (el: Element) =>
    act(async () => void el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as any));
  assert.equal(v.host.querySelector('.project-row')!.getAttribute('aria-label'), 'Alpha');
  await enter(v.host.querySelector('.project-row')!);
  await enter(v.host.querySelector('[aria-label="Project actions"]')!);
  assert.deepEqual(calls, [
    ['setState', { newChatProjectId: 'a', newChatCwd: null }],
    ['navigate', { name: 'home', cwd: '/p/alpha' }],
  ]);
  calls.length = 0;
  await click(v.host.querySelector('[aria-label="Project actions"]'));
  assert.deepEqual(calls, [], 'the actions button does not open the project');
  await click(byText(v.host, 'New chat in project'));
  assert.equal(calls.length, 2);
  calls.length = 0;
  await click(v.host.querySelector('[aria-label="Project actions"]'));
  await click(byText(v.host, 'Open in Finder'));
  assert.deepEqual(calls, [['showInFinder', '/p/alpha']], 'a menu pick does not also open the project');
  calls.length = 0;
  confirmAnswer = false;
  await click(v.host.querySelector('[aria-label="Project actions"]'));
  await click(byText(v.host, 'Remove project'));
  assert.deepEqual(calls, [['confirm', 'Remove Alpha from Projects? Files on disk are not touched.']]);
  calls.length = 0;
  confirmAnswer = true;
  await click(v.host.querySelector('[aria-label="Project actions"]'));
  await click(byText(v.host, 'Remove project'));
  assert.deepEqual(calls, [
    ['confirm', 'Remove Alpha from Projects? Files on disk are not touched.'],
    ['delete', 'a'],
  ]);
  await v.unmount();
});

test('a rejected project removal shows the reason and retains the project row', async () => {
  groups = [{ id: 'a', name: 'Alpha', saved: true, path: '/p/alpha', threads: [] }];
  const v = await render(h(Projects));
  confirmAnswer = true;
  deleteError = new Error('The project list was saved by a newer version');
  try {
    calls.length = 0;
    await click(v.host.querySelector('[aria-label="Project actions"]'));
    await click(byText(v.host, 'Remove project'));
    assert.deepEqual(calls.at(-1), ['toast', "Couldn't remove the project", deleteError.message]);
    assert.deepEqual(names(v.host), ['Alpha']);
  } finally {
    deleteError = null;
    await v.unmount();
  }
});

test('a project with more chats than a function argument limit still renders its count and recency', async () => {
  groups = [
    { id: 'large', name: 'Large', saved: true, path: '/large', threads: Array.from({ length: 150000 }, (_, i) => ({ updatedAt: i })) },
    { id: 'small', name: 'Small', saved: true, path: '/small', threads: [{ updatedAt: 2 }] },
  ];
  const v = await render(h(Projects));
  try {
    assert.deepEqual(names(v.host), ['Large', 'Small']);
    assert.equal(v.host.querySelector('.settings-value')!.textContent, '150000 chats · t149999');
  } finally {
    await v.unmount();
  }
});
