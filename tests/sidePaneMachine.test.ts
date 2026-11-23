// The side pane for a chat that runs on a machine: its Changes, Files and file tabs say the folder is on the machine instead of reading this Mac, and nothing is read while the chat's owner is not known yet.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, one, render } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({
  paneTabs: [],
  paneActive: null,
  paneFull: false,
  agentTabs: {},
  segments: {},
  threads: { t1: { cwd: '/srv/app' } },
});
const { createElement: h, act } = await import('react');
const stub = (name: string) => (props: any) =>
  h('section', { 'data-stub': name, 'data-props': JSON.stringify(props, (_k, v) => (typeof v === 'function' ? undefined : v)) });
stubStore({ ...store.exports, chatOf: (id: string) => id });
mock.module('../src/components/panels/DiffPanel.tsx', { namedExports: { DiffPanel: stub('diff') } });
mock.module('../src/components/panels/MachineChanges.tsx', { namedExports: { MachineChanges: stub('machine-changes') } });
mock.module('../src/components/panels/files/RemoteFiles.tsx', {
  namedExports: { RemoteFilesPanel: stub('remote-files'), RemoteFilePreview: stub('remote-file') },
});
mock.module('../src/components/panels/FilesPanel.tsx', { namedExports: { FilesPanel: stub('files'), FilePreview: stub('file') } });
for (const [file, name] of [
  ['PlanPanel', 'PlanPanel'],
  ['SkillPanel', 'SkillPanel'],
  ['BrowserPanel', 'BrowserPanel'],
  ['ArtifactPanel', 'ArtifactPanel'],
  ['OutputsPanel', 'OutputsPanel'],
  ['UsagePanel', 'UsagePanel'],
] as const)
  mock.module(`../src/components/panels/${file}.tsx`, { namedExports: { [name]: stub(name) } });
mock.module('../src/components/panels/TerminalPanel.tsx', { namedExports: { TermView: stub('term') } });
mock.module('../src/session/harness/claude.ts', { namedExports: { recheckClaude: async () => undefined } });
mock.module('../src/components/composer/Composer.tsx', { namedExports: { Composer: stub('composer') } });
mock.module('../src/components/thread/ThreadView.tsx', { namedExports: { ThreadView: stub('thread') } });
mock.module('../src/components/tasks/TasksTab.tsx', { namedExports: { TasksTab: stub('tasks') } });
let chatMachine: { machine: { id: string; name: string; away: boolean } | null; pending: boolean } = { machine: null, pending: false };
mock.module('../src/lib/chatMachine.ts', { namedExports: { useChatMachine: () => chatMachine } });
const { SidePane } = await import('../src/components/panels/SidePane.tsx');
(globalThis as any).HTMLElement.prototype.animate = () => ({ cancel: () => undefined });
(globalThis as any).ResizeObserver = class {
  observe() {}
  disconnect() {}
};

// the remote panes load on first use: a turn of the event loop lets them in
const lazyFlush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
const stubs = (host: ParentNode) => [...host.querySelectorAll('[data-stub]')].map((e) => e.getAttribute('data-stub'));
const notes = (host: ParentNode) => [...host.querySelectorAll('.machine-folder-note')].map((n) => n.textContent);

test("a chat on a machine says so in the Changes, Files and file tabs instead of reading this Mac's folder", async () => {
  store.set({
    paneActive: 'c',
    paneFull: false,
    paneTabs: [
      { id: 'c', kind: 'changes' },
      { id: 'f', kind: 'files' },
      { id: 'p', kind: 'file', path: '/srv/a.ts' },
      { id: 'q', kind: 'file', path: '/elsewhere/b.ts', cwd: '/elsewhere' },
    ],
  });
  chatMachine = { machine: { id: 'm', name: 'box', away: false }, pending: false };
  const r = await render(h(SidePane, { cwd: '/srv', threadId: 't1' }));
  await lazyFlush();
  // the Changes tab reads the machine's repository through its Host; offline it says so
  assert.deepEqual([stubs(r.host), notes(r.host)], [['machine-changes'], []]);
  assert.deepEqual(JSON.parse(one(r.host, '[data-stub="machine-changes"]').getAttribute('data-props')!), {
    machine: { id: 'm', name: 'box', away: false },
    threadId: 't1',
  });
  chatMachine = { machine: { id: 'm', name: 'box', away: true }, pending: false };
  await r.rerender(h(SidePane, { cwd: '/srv', threadId: 't1' }));
  await lazyFlush();
  assert.deepEqual([stubs(r.host), notes(r.host)], [[], ["Changes aren't available while box is offline."]]);
  chatMachine = { machine: { id: 'm', name: 'box', away: false }, pending: false };
  await r.rerender(h(SidePane, { cwd: '/srv', threadId: 't1' }));
  await lazyFlush();
  // the Files tab reads the machine's folder through its Host
  await act(() => store.set({ paneActive: 'f' }));
  await lazyFlush();
  assert.deepEqual([stubs(r.host), notes(r.host)], [['remote-files'], []]);
  assert.deepEqual(JSON.parse(one(r.host, '[data-stub="remote-files"]').getAttribute('data-props')!), {
    machine: { id: 'm', name: 'box', away: false },
    threadId: 't1',
  });
  // an offline machine is not asked
  chatMachine = { machine: { id: 'm', name: 'box', away: true }, pending: false };
  await r.rerender(h(SidePane, { cwd: '/srv', threadId: 't1' }));
  await lazyFlush();
  assert.deepEqual([stubs(r.host), notes(r.host)], [[], ["Files aren't available while box is offline."]]);
  chatMachine = { machine: { id: 'm', name: 'box', away: false }, pending: false };
  await r.rerender(h(SidePane, { cwd: '/srv', threadId: 't1' }));
  await lazyFlush();
  await act(() => store.set({ paneActive: 'p' }));
  await lazyFlush();
  assert.deepEqual([stubs(r.host), notes(r.host)], [[], ["Files aren't shown for a folder on box."]]);
  // a file tab that names its own folder is that folder's, not the chat's
  await act(() => store.set({ paneActive: 'q' }));
  await lazyFlush();
  assert.deepEqual([stubs(r.host), notes(r.host)], [['file'], []]);
  assert.equal(JSON.parse(one(r.host, '[data-stub="file"]').getAttribute('data-props')!).cwd, '/elsewhere');
  // a file opened from a link in the chat is read from the machine it names
  store.set({
    paneTabs: [{ id: 'r', kind: 'file', path: '/srv/app/src/a.ts', cwd: 'host:ssh:me@box\n/srv/app', version: 'auto:3' }],
    paneActive: 'r',
  });
  await lazyFlush();
  assert.deepEqual(stubs(r.host), ['remote-file']);
  assert.deepEqual(JSON.parse(one(r.host, '[data-stub="remote-file"]').getAttribute('data-props')!), {
    machineId: 'ssh:me@box',
    path: '/srv/app/src/a.ts',
    reload: 'auto:3',
  });
  await r.unmount();
});

test('while the chat’s owner is not known nothing reads the folder, and a chat on this Mac gets its panels', async () => {
  store.set({
    paneActive: 'c',
    paneFull: false,
    paneTabs: [
      { id: 'c', kind: 'changes' },
      { id: 'f', kind: 'files' },
      { id: 'p', kind: 'file', path: '/srv/a.ts' },
    ],
  });
  chatMachine = { machine: null, pending: true };
  const r = await render(h(SidePane, { cwd: '/srv', threadId: 't1' }));
  for (const tab of ['c', 'f', 'p']) {
    await act(() => store.set({ paneActive: tab }));
    assert.deepEqual([stubs(r.host), notes(r.host)], [[], []], tab);
  }
  chatMachine = { machine: null, pending: false };
  for (const [tab, name] of [
    ['c', 'diff'],
    ['f', 'files'],
    ['p', 'file'],
  ] as const) {
    await act(() => store.set({ paneActive: tab }));
    await r.rerender(h(SidePane, { cwd: '/srv', threadId: 't1' }));
    assert.deepEqual(stubs(r.host), [name], tab);
  }
  await r.unmount();
});
