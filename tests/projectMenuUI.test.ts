// The project menu's local selection and keyboard behavior, isolated from unused remote-terminal actions.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement } from 'react';
import { fakeStore, popoverExports, render, click, type, press, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { mockSource, stubStore } from './support/stubs.ts';

mockSource('src/components/pages/settings/Connections.tsx', {
  openSshTerminal: () => {
    throw new Error('The project menu must not open a terminal.');
  },
});

const PROJECTS = [
  { id: 'p1', name: 'Alpha', roots: [{ path: '/work/Alpha' }] },
  { id: 'p2', name: 'Beta', roots: [{ path: '/work/beta-repo' }] },
  { id: 'p3', name: 'Gamma', roots: [] },
];
const store = fakeStore<any>({ savedProjects: PROJECTS, newChatProjectId: null });
let current: any = null;
let folder: string | null = null;
let created: string | null = null;
const calls: any[] = [];
stubStore({
  useStore: store.useStore,
  setState: store.setState,
  newChatGoal: (s: any) => (current && s.newChatProjectId !== 'none' ? { kind: 'project', project: current } : null),
  createProject: async (p: string) => (calls.push(['create', p]), created),
});
installNativeStub({ dialog: { openFolder: async () => (calls.push(['openFolder']), folder) } });
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
const { ProjectMenu } = await import('../src/components/composer/ProjectMenu.tsx');

let closes = 0;
const menu = (open: boolean, placement?: any) => createElement(ProjectMenu, { anchor: null, open, onClose: () => closes++, placement });
const rows = (host: Element) => [...host.querySelectorAll('.menu-scroll .menu-item')];
const titles = (host: Element) => rows(host).map((r) => r.querySelector('.menu-title')!.textContent);
const input = (host: Element) => host.querySelector('input') as HTMLInputElement;
const reset = (state: any = {}) => {
  store.reset({ savedProjects: PROJECTS, newChatProjectId: null, ...state });
  current = null;
  folder = null;
  created = null;
  calls.length = 0;
  closes = 0;
};

test('closed, nothing is rendered; opened, it lists projects with their folder when it differs, focusing the search', async () => {
  reset();
  const { host, rerender, unmount } = await render(menu(false));
  assert.equal(host.innerHTML, '');
  await rerender(menu(true));
  await flush();
  assert.equal(host.querySelector('[data-popover]')!.getAttribute('data-popover'), 'top-start');
  assert.deepEqual(titles(host), ['Alpha', 'Beta beta-repo', 'Gamma']);
  assert.equal(document.activeElement, input(host));
  assert.equal(host.querySelector('.menu-scroll .menu-check svg'), null, 'no project is checked');
  await unmount();
});

test('search matches names and folder paths; no matches shows "No projects"', async () => {
  reset();
  const { host, unmount } = await render(menu(true, 'bottom-start'));
  assert.equal(host.querySelector('[data-popover]')!.getAttribute('data-popover'), 'bottom-start');
  await type(input(host), 'ALP');
  assert.deepEqual(titles(host), ['Alpha']);
  await type(input(host), 'repo');
  assert.deepEqual(titles(host), ['Beta beta-repo']);
  await type(input(host), 'zzz');
  assert.deepEqual(titles(host), []);
  assert.equal(host.querySelector('.menu-empty')!.textContent, 'No projects');
  await press(input(host), 'Enter');
  assert.equal(closes, 0, 'Enter with nothing listed does nothing');
  await unmount();
});

test('arrow keys move the highlight within bounds, the mouse moves it too, and Enter picks it', async () => {
  reset();
  const { host, unmount } = await render(menu(true));
  const active = () => rows(host).findIndex((r) => r.classList.contains('kbd-active'));
  assert.equal(active(), 0);
  await press(input(host), 'ArrowUp');
  assert.equal(active(), 0);
  for (const want of [1, 2, 2]) {
    await press(input(host), 'ArrowDown');
    assert.equal(active(), want);
  }
  await press(input(host), 'ArrowUp');
  assert.equal(active(), 1);
  await press(input(host), 'a');
  assert.equal(active(), 1);
  const { act } = await import('react');
  await act(async () => rows(host)[0].dispatchEvent(new (globalThis as any).window.MouseEvent('mousemove', { bubbles: true })));
  assert.equal(active(), 0);
  await press(input(host), 'ArrowDown');
  await press(input(host), 'Enter', { isComposing: true });
  assert.equal(closes, 0, 'an IME confirmation is not a pick');
  await press(input(host), 'Enter');
  assert.equal(closes, 1);
  assert.equal(store.getState().newChatProjectId, 'p2');
  assert.equal(store.getState().newChatCwd, null);
  await unmount();
});

test('clicking a project chooses it; the current project is checked unless "no project" is selected', async () => {
  reset({ newChatProjectId: 'p1' });
  current = PROJECTS[0];
  const { host, unmount } = await render(menu(true));
  const checked = () => [...host.querySelectorAll('.menu-check')].map((c) => !!c.querySelector('svg'));
  assert.deepEqual(checked(), [true, false, false, false]);
  await click(rows(host)[2]);
  assert.equal(store.getState().newChatProjectId, 'p3');
  assert.equal(closes, 1);
  await click([...host.querySelectorAll('.menu-item')].find((e) => e.textContent!.includes("Don't work in a project")));
  assert.equal(store.getState().newChatProjectId, 'none');
  assert.deepEqual(checked(), [false, false, false, true]);
  await unmount();
});

test('"New project" closes, then creates a project from the chosen folder and selects it', async () => {
  reset({ newChatProjectId: 'p1', newChatCwd: '/tmp/x' });
  const { host, unmount } = await render(menu(true));
  const newProject = () => [...host.querySelectorAll('.menu-item')].find((e) => e.textContent!.includes('New project'))!;
  // the folder dialog is cancelled
  await click(newProject());
  assert.equal(closes, 1);
  assert.deepEqual(calls, [['openFolder']]);
  // the project could not be created
  folder = '/work/new';
  await click(newProject());
  assert.deepEqual(calls.slice(1), [['openFolder'], ['create', '/work/new']]);
  assert.equal(store.getState().newChatProjectId, 'p1');
  assert.equal(store.getState().newChatCwd, '/tmp/x');
  // created
  created = 'p9';
  await click(newProject());
  assert.equal(store.getState().newChatProjectId, 'p9');
  assert.equal(store.getState().newChatCwd, null);
  await unmount();
});

test('reopening clears the search and the highlight', async () => {
  reset();
  const { host, rerender, unmount } = await render(menu(true));
  await type(input(host), 'beta');
  await rerender(menu(false));
  await rerender(menu(true));
  assert.equal(input(host).value, '');
  assert.deepEqual(titles(host), ['Alpha', 'Beta beta-repo', 'Gamma']);
  await unmount();
});
