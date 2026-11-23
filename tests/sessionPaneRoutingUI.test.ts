// The real side pane routes session outputs, usage and generated file versions only to their active owning view.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { fakeStore, render } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';
const store = fakeStore({ paneTabs: [], paneActive: '', paneFull: false, agentTabs: {}, segments: {}, prefs: {} });
stubStore({ ...store.exports, chatOf: (id: string) => id });
const empty = () => null;
const stub = (kind: string) => (props: any) => h('div', { 'data-kind': kind, 'data-props': JSON.stringify(props) });
mock.module('../src/components/panels/DiffPanel.tsx', { namedExports: { DiffPanel: empty } });
// the remote Files pane draws file glyphs from the diff pane: a chat on this Mac never mounts it
mock.module('../src/components/panels/files/RemoteFiles.tsx', {
  namedExports: { RemoteFilesPanel: () => null, RemoteFilePreview: () => null },
});
mock.module('../src/components/panels/FilesPanel.tsx', { namedExports: { FilesPanel: empty, FilePreview: stub('file') } });
mock.module('../src/components/panels/PlanPanel.tsx', { namedExports: { PlanPanel: empty } });
mock.module('../src/components/panels/OutputsPanel.tsx', { namedExports: { OutputsPanel: stub('outputs') } });
mock.module('../src/components/panels/UsagePanel.tsx', { namedExports: { UsagePanel: stub('usage') } });
mock.module('../src/components/panels/SkillPanel.tsx', { namedExports: { SkillPanel: empty } });
mock.module('../src/components/panels/BrowserPanel.tsx', { namedExports: { BrowserPanel: empty } });
mock.module('../src/components/panels/ArtifactPanel.tsx', { namedExports: { ArtifactPanel: empty } });
mock.module('../src/components/panels/TerminalPanel.tsx', { namedExports: { TermView: empty } });
mock.module('../src/components/composer/Composer.tsx', { namedExports: { Composer: empty } });
mock.module('../src/components/thread/ThreadView.tsx', { namedExports: { ThreadView: empty } });
mock.module('../src/components/tasks/TasksTab.tsx', { namedExports: { TasksTab: empty } });
mock.module('../src/session/harness/claude.ts', { namedExports: { recheckClaude: async () => {} } });
const { SidePane } = await import('../src/components/panels/SidePane.tsx');
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
} as any;
window.HTMLElement.prototype.animate = (() => ({ cancel() {} })) as any;

test('session panels mount only in front and generated files receive their refresh version', async () => {
  store.set({
    paneTabs: [
      { id: 'outputs', kind: 'outputs', threadId: 'a', ownerChat: 'a' },
      { id: 'usage', kind: 'usage', threadId: 'a', ownerChat: 'a' },
      { id: 'file', kind: 'file', path: '/repo/a.html', cwd: '/repo', version: 'published-2' },
      { id: 'missing', kind: 'outputs' },
      { id: 'missing-usage', kind: 'usage' },
      { id: 'other', kind: 'outputs', threadId: 'b', ownerChat: 'b' },
    ],
    paneActive: 'outputs',
  });
  const v = await render(h(SidePane, { cwd: '/repo', threadId: 'a' }));
  assert.deepEqual(JSON.parse(v.host.querySelector('[data-kind="outputs"]')!.getAttribute('data-props')!), { threadId: 'a' });
  await act(() => store.set({ paneActive: 'usage' }));
  assert.equal(v.host.querySelector('[data-kind="outputs"]'), null);
  assert.deepEqual(JSON.parse(v.host.querySelector('[data-kind="usage"]')!.getAttribute('data-props')!), { threadId: 'a' });
  await act(() => store.set({ paneActive: 'file' }));
  assert.equal(JSON.parse(v.host.querySelector('[data-kind="file"]')!.getAttribute('data-props')!).revision, 'published-2');
  for (const paneActive of ['missing', 'missing-usage', 'other']) {
    await act(() => store.set({ paneActive }));
    assert.equal(v.host.querySelector('[data-kind="outputs"], [data-kind="usage"]'), null);
  }
  await v.unmount();
});
