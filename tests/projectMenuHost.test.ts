// The project menu's entries for remote machines (src/components/composer/ProjectMenu.tsx): only for an invited account and only for machines that are online; one opens the folder picker, and the folder picked there becomes the next new chat's target, replacing a project or a local folder (A5).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll, impl, native } from './support/store-harness.ts';
await import('./support/dom.ts');
(window as any).native = native;
const { act, createElement } = await import('react');
const { popoverExports, render, click, flush } = await import('./support/shell-chrome-kit.ts');
const { mockSource } = await import('./support/stubs.ts');
const { store, resetState } = await loadStore();

const { selectLocalProject } = await import('../src/store/localProjectDraft.ts');
const { newChatTarget, setNewChatHostFolder } = await import('../src/store/projects.ts');
const SAGE = { id: 'p1', name: 'Sage', roots: [{ path: '/local/Sage' }] };
let allowed = true;
let machines = [
  { id: 'box', name: 'build-box', status: 'online', note: '' },
  { id: 'lab', name: 'lab', status: 'offline', note: '' },
  { id: 'old', name: 'old', status: 'attention', note: '' },
];
mockSource('src/lib/host.ts', { useHostAccess: () => allowed });
mockSource('src/components/pages/settings/Connections.tsx', {
  openSshTerminal: () => {
    throw new Error('The project menu must not open a terminal.');
  },
});
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines, resolved: true }) });
const listed: unknown[] = [];
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
const { ProjectMenu } = await import('../src/components/composer/ProjectMenu.tsx');

let closes = 0;
const menu = () => createElement(ProjectMenu, { anchor: null, open: true, onClose: () => closes++ });
const hostRows = (host: Element) =>
  [...host.querySelectorAll('.menu-item')].map((r) => r.textContent).filter((t) => t?.startsWith('Folder on'));
const checkedRows = (host: Element) =>
  [...host.querySelectorAll('.menu-item')].filter((row) => row.querySelector('.menu-check svg')).map((row) => row.textContent);

beforeEach(() => {
  resetState();
  resetAll();
  store.setState({ savedProjects: [SAGE] });
  listed.length = 0;
  closes = 0;
  impl['host.fsList'] = async (id: string, q: unknown) => (
    listed.push([id, q]), { value: { path: '/checkout/mopilot', roots: ['/checkout/mopilot'], entries: [] } }
  );
});

test('an invited account sees one entry per online machine; none without access', async () => {
  allowed = true;
  const { host, rerender, unmount } = await render(menu());
  assert.deepEqual(hostRows(host), ['Folder on build-box…']);
  allowed = false;
  await rerender(menu());
  assert.deepEqual(hostRows(host), []);
  allowed = true;
  await unmount();
});

test('picking a remote folder replaces the saved project and checks the matching machine row', async (t) => {
  selectLocalProject(SAGE.id);
  const { host, unmount } = await render(menu());
  t.after(unmount);
  assert.deepEqual(checkedRows(host), ['Sage']);
  await click([...host.querySelectorAll('.menu-item')].find((r) => r.textContent?.startsWith('Folder on')));
  assert.equal(closes, 1);
  await flush();
  assert.deepEqual(listed[0], ['box', { path: undefined }]);
  assert.equal(document.querySelector('.dialog-head')!.textContent?.includes('Folder on build-box'), true);
  await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Use this folder'));
  assert.deepEqual(newChatTarget(), { name: 'mopilot · build-box', path: '', projectId: null });
  assert.equal(store.getState().newChatProjectId, null);
  assert.equal(store.getState().newChatCwd, null);
  assert.equal(document.querySelector('.dialog-head'), null, 'the picker closed');
  assert.deepEqual(checkedRows(host), ['Folder on build-box…']);
  assert.equal(host.querySelector('[role="option"]')?.getAttribute('aria-selected'), 'false');
  assert.equal(host.querySelector('[aria-current="true"]')?.textContent, 'Folder on build-box…');
  await click(host.querySelector('[role="option"]'));
  assert.deepEqual(newChatTarget(), { name: 'Sage', path: '/local/Sage', projectId: SAGE.id });
  assert.deepEqual(checkedRows(host), ['Sage']);
});

test('closing the picker keeps the target as it was', async () => {
  selectLocalProject(SAGE.id);
  const { host, unmount } = await render(menu());
  await click([...host.querySelectorAll('.menu-item')].find((r) => r.textContent?.startsWith('Folder on')));
  await flush();
  await click(document.querySelector('button[aria-label="Close"]'));
  assert.equal(document.querySelector('.dialog-head'), null);
  assert.equal(store.getState().newChatProjectId, 'p1');
  assert.equal(store.getState().newChatHost, null);
  await unmount();
});

test('the default project only stays checked while it is the effective target', async (t) => {
  const { host, unmount } = await render(menu());
  t.after(unmount);
  assert.deepEqual(checkedRows(host), ['Sage']);
  await act(() => selectLocalProject(null, '/local/folder'));
  assert.deepEqual(checkedRows(host), [], 'a standalone local folder has no project row');
  await act(() => setNewChatHostFolder(machines[0], ''));
  assert.deepEqual(checkedRows(host), [], 'choosing a machine without a folder checks no row');
  await act(() => store.setState({ route: { name: 'thread', id: 'existing-chat' } }));
  await act(() => setNewChatHostFolder(machines[0], '/checkout/mopilot'));
  assert.deepEqual(checkedRows(host), ['Folder on build-box…'], 'the picker also works outside the home page');
  await act(() => setNewChatHostFolder(machines[1], '/checkout/mopilot'));
  assert.deepEqual(checkedRows(host), [], 'an offline current machine has no browse row');
  await act(() => selectLocalProject('none'));
  assert.deepEqual(checkedRows(host), ["Don't work in a project"]);
});
