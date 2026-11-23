// Real split-tool routing preserves one resource per tab and selects visible tools across every harness.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act, useEffect } from 'react';
import { fakeStore, render } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';
const store = fakeStore({ paneTabs: [], paneActive: '', paneFull: false, agentTabs: {}, segments: {}, prefs: {} });
stubStore({ ...store.exports, chatOf: (id: string) => id });
const empty = () => null;
const mounts: Record<string, number> = {};
const exits: Record<string, number> = {};
function resource(kind: string) {
  return (props: any) => {
    const id = props.tabId ?? props.tab?.id ?? props.threadId;
    useEffect(() => {
      mounts[id] = (mounts[id] ?? 0) + 1;
      return () => {
        exits[id] = (exits[id] ?? 0) + 1;
      };
    }, [id]);
    return h('textarea', { 'data-kind': kind, 'data-id': id, 'data-props': JSON.stringify(props), defaultValue: 'retained' });
  };
}
const stub = (kind: string) => (props: any) => h('div', { 'data-kind': kind, 'data-props': JSON.stringify(props) });
mock.module('../src/components/panels/DiffPanel.tsx', { namedExports: { DiffPanel: stub('changes') } });
// the remote Files pane draws file glyphs from the diff pane: a chat on this Mac never mounts it
mock.module('../src/components/panels/files/RemoteFiles.tsx', {
  namedExports: { RemoteFilesPanel: () => null, RemoteFilePreview: () => null },
});
mock.module('../src/components/panels/FilesPanel.tsx', { namedExports: { FilesPanel: stub('files'), FilePreview: stub('file') } });
mock.module('../src/components/panels/PlanPanel.tsx', { namedExports: { PlanPanel: stub('plan') } });
mock.module('../src/components/panels/OutputsPanel.tsx', { namedExports: { OutputsPanel: stub('outputs') } });
mock.module('../src/components/panels/UsagePanel.tsx', { namedExports: { UsagePanel: stub('usage') } });
mock.module('../src/components/panels/SkillPanel.tsx', { namedExports: { SkillPanel: empty } });
mock.module('../src/components/panels/BrowserPanel.tsx', { namedExports: { BrowserPanel: resource('browser') } });
mock.module('../src/components/panels/ArtifactPanel.tsx', { namedExports: { ArtifactPanel: stub('artifact') } });
mock.module('../src/components/panels/TerminalPanel.tsx', { namedExports: { TermView: resource('terminal') } });
mock.module('../src/components/composer/Composer.tsx', { namedExports: { Composer: empty } });
mock.module('../src/components/thread/ThreadView.tsx', { namedExports: { ThreadView: resource('chat') } });
mock.module('../src/components/tasks/TasksTab.tsx', { namedExports: { TasksTab: empty } });
mock.module('../src/session/harness/claude.ts', { namedExports: { recheckClaude: async () => {} } });
const { SidePane } = await import('../src/components/panels/SidePane.tsx');
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
} as any;
window.HTMLElement.prototype.animate = (() => ({ cancel() {} })) as any;

import { splitToolLayout, toolLayoutScope, rememberToolLayout, resetToolLayouts, toolLayout } from '../src/lib/toolPaneLayout.ts';
beforeEach(() => {
  resetToolLayouts();
  for (const id of Object.keys(mounts)) delete mounts[id];
  for (const id of Object.keys(exits)) delete exits[id];
});
const props = (host: HTMLElement, kind: string) => JSON.parse(host.querySelector(`[data-kind="${kind}"]`)!.getAttribute('data-props')!);
const visible = (host: HTMLElement) =>
  [...host.querySelectorAll('.pane-tab-body')]
    .filter((e) => !(e as HTMLElement).hidden && !e.classList.contains('pane-tab-back'))
    .map((e) => e.getAttribute('data-tool-tab'));
async function split(chat: string, target: string, axis: 'rows' | 'columns' = 'columns') {
  await act(() => {
    const scope = toolLayoutScope(chat);
    rememberToolLayout(scope, splitToolLayout(toolLayout(scope), target, axis));
    store.set({ paneActive: target });
  });
}
for (const family of ['codex', 'claude', 'acp'])
  test(`${family}: browser and terminal remain visible with one owner as focus, orientation and native segment change`, async () => {
    const chat = `stable-${family}`;
    store.set({
      paneTabs: [
        { id: 'b', kind: 'browser', ownerChat: chat },
        { id: 't', kind: 'terminal', ownerChat: chat },
        { id: 'f', kind: 'files' },
      ],
      paneActive: 'b',
      segments: {
        [chat]: [{ harness: family === 'acp' ? 'acp:kimi' : family, nativeId: 'one', start: 0, count: null, model: null, handoff: null }],
      },
      prefs: {},
    });
    const v = await render(h(SidePane, { cwd: '/repo', threadId: chat }));
    await split(chat, 't');
    assert.deepEqual(visible(v.host), ['b', 't']);
    assert.equal(props(v.host, 'browser').layer, 'front');
    assert.equal(props(v.host, 'terminal').visible, true);
    assert.equal(mounts.b, 1);
    assert.equal(mounts.t, 1);
    await act(() => v.host.querySelector('[data-id="b"]')!.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true })));
    assert.equal(store.get().paneActive, 'b');
    await act(() => v.host.querySelector('[data-id="t"]')!.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
    assert.equal(store.get().paneActive, 't');
    await act(() =>
      store.set({
        segments: {
          [chat]: [
            { harness: family === 'codex' ? 'claude' : 'codex', nativeId: 'two', start: 1, count: null, model: null, handoff: null },
          ],
        },
      }),
    );
    assert.deepEqual(visible(v.host), ['b', 't']);
    assert.equal(mounts.b, 1);
    assert.equal(exits.b, undefined);
    await act(() => store.set({ paneActive: 'f' }));
    assert.deepEqual(visible(v.host), ['b', 'f']);
    assert.equal(props(v.host, 'terminal').visible, false);
    assert.equal(mounts.t, 1);
    assert.equal(exits.t, undefined);
    await act(() => store.set({ paneActive: 'b' }));
    await act(() => (v.host.querySelector('[aria-label="Return to one tool pane"]') as HTMLElement).click());
    assert.deepEqual(visible(v.host), ['b']);
    assert.equal(mounts.b, 1);
    await v.unmount();
    assert.equal(exits.b, 1);
    assert.equal(exits.t, 1);
  });

test('owner filtering, chat switching and closed resources preserve each chat’s own arrangement', async () => {
  store.set({
    paneTabs: [
      { id: 'a-file', kind: 'file', path: '/a/a.ts', ownerChat: 'a' },
      { id: 'a-browser', kind: 'browser', ownerChat: 'a' },
      { id: 'b-file', kind: 'file', path: '/b/b.ts', ownerChat: 'b' },
      { id: 'b-browser', kind: 'browser', ownerChat: 'b' },
    ],
    paneActive: 'a-file',
    prefs: {},
  });
  const v = await render(h(SidePane, { cwd: '/a', threadId: 'a' }));
  await split('a', 'a-browser', 'rows');
  const saved = toolLayout(toolLayoutScope('a'));
  await act(() => store.set({ paneActive: 'b-file' }));
  await v.rerender(h(SidePane, { cwd: '/b', threadId: 'b' }));
  assert.deepEqual(visible(v.host), ['b-file']);
  await split('b', 'b-browser');
  await act(() => store.set({ paneActive: 'a-browser' }));
  await v.rerender(h(SidePane, { cwd: '/a', threadId: 'a' }));
  assert.deepEqual(visible(v.host), ['a-file', 'a-browser']);
  assert.equal(toolLayout(toolLayoutScope('a')).axis, saved.axis);
  await act(() => store.set({ paneTabs: store.get().paneTabs.filter((t: any) => t.id !== 'a-browser'), paneActive: 'a-file' }));
  assert.deepEqual(visible(v.host), ['a-file']);
  assert.equal(exits['a-browser'], 1);
  await v.unmount();
});

test('a hidden split retains shells but ignores background focus; reopening keeps the arrangement', async () => {
  store.set({
    paneTabs: [
      { id: 'b', kind: 'browser', ownerChat: 'a' },
      { id: 't', kind: 'terminal', ownerChat: 'a' },
    ],
    paneActive: 'b',
    prefs: {},
  });
  const v = await render(h(SidePane, { cwd: '/a', threadId: 'a' }));
  await split('a', 't');
  await v.rerender(h(SidePane, { cwd: '/a', threadId: 'a', hidden: true }));
  assert.equal(props(v.host, 'terminal').visible, false);
  await act(() => v.host.querySelector('[data-id="b"]')!.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true })));
  assert.equal(store.get().paneActive, 't');
  await v.rerender(h(SidePane, { cwd: '/a', threadId: 'a' }));
  assert.deepEqual(visible(v.host), ['b', 't']);
  assert.equal(mounts.t, 1);
  await v.unmount();
});

test('plan, outputs, usage, artifacts and side-chat-owned files can share visible slots; foreign tools stay hidden', async () => {
  const tabs: any[] = [
    { id: 'p', kind: 'plan', threadId: 'a', ownerChat: 'a' },
    { id: 'o', kind: 'outputs', threadId: 'a', ownerChat: 'a' },
    { id: 'u', kind: 'usage', threadId: 'a', ownerChat: 'a' },
    { id: 'art', kind: 'artifact', title: 'Artifact' },
    { id: 'side', kind: 'chat', threadId: 'side' },
    { id: 'file', kind: 'file', path: '/side/a.ts', ownerChat: 'side' },
    { id: 'foreign', kind: 'file', path: '/foreign/a.ts', ownerChat: 'foreign' },
  ];
  store.set({ paneTabs: tabs, paneActive: 'p', prefs: {} });
  const v = await render(h(SidePane, { cwd: '/a', threadId: 'a' }));
  for (const id of ['o', 'u', 'art']) await split('a', id, 'rows');
  assert.deepEqual(visible(v.host), ['p', 'o', 'u', 'art']);
  assert.equal(props(v.host, 'artifact').shown, true);
  await act(() => store.set({ paneActive: 'file' }));
  assert.deepEqual(visible(v.host), ['p', 'o', 'u', 'file']);
  assert.equal(props(v.host, 'file').path, '/side/a.ts');
  await act(() => store.set({ paneActive: 'foreign' }));
  assert.ok(!visible(v.host).includes('foreign'));
  assert.equal(mounts.side, 1);
  await v.unmount();
});
