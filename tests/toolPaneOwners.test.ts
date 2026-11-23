// Tool arrangement ownership uses the production stable-chat/native-alias mapper through mixed harness switches.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll } from './support/store-harness.ts';
import { inView, viewChats, frontTab } from '../src/lib/agentTabs.ts';
import { projectToolLayout, splitToolLayout, toolLayout, resetToolLayouts } from '../src/lib/toolPaneLayout.ts';
const { store, resetState } = await loadStore();
beforeEach(() => {
  resetState();
  resetAll();
  resetToolLayouts();
});
test('native-owned tools retain their stable chat through Codex, Claude and ACP segments; foreign tools never enter its layout', () => {
  store.useStore.setState({
    segments: {
      stable: [
        { harness: 'codex', nativeId: 'cx', start: 1, count: null, model: null, handoff: null },
        { harness: 'claude', nativeId: 'cc', start: 2, count: null, model: null, handoff: null },
        { harness: 'acp:kimi', nativeId: 'ac', start: 3, count: null, model: null, handoff: null },
      ],
      other: [{ harness: 'codex', nativeId: 'other-native', start: 1, count: null, model: null, handoff: null }],
    } as any,
  });
  const tabs: any[] = [
    { id: 'file', kind: 'file', ownerChat: 'cx' },
    { id: 'browser', kind: 'browser', agentChat: 'cc' },
    { id: 'shell', kind: 'terminal', ownerChat: 'ac' },
    { id: 'foreign', kind: 'file', ownerChat: 'other-native' },
  ];
  const shown = () => tabs.filter((t) => inView(t, viewChats('stable', tabs), store.chatOf)).map((t) => t.id);
  assert.equal(store.chatOf('cx'), 'stable');
  assert.equal(store.chatOf('cc'), 'stable');
  assert.equal(store.chatOf('ac'), 'stable');
  let layout = projectToolLayout(toolLayout('stable'), shown(), frontTab(tabs, 'file', viewChats('stable', tabs), store.chatOf));
  layout = splitToolLayout(layout, 'browser', 'columns');
  layout = splitToolLayout(layout, 'shell', 'rows');
  assert.deepEqual(layout.ids, ['file', 'browser', 'shell']);
  assert.ok(!shown().includes('foreign'));
  store.useStore.setState({
    segments: {
      ...store.useStore.getState().segments,
      stable: [
        ...store.useStore.getState().segments.stable,
        { harness: 'codex', nativeId: 'new-cx', start: 4, count: null, model: null, handoff: null },
      ],
    } as any,
  });
  assert.equal(store.chatOf('new-cx'), 'stable');
  assert.deepEqual(projectToolLayout(layout, shown(), 'shell').ids, layout.ids);
  assert.deepEqual(
    tabs.filter((t) => inView(t, viewChats('other', tabs), store.chatOf)).map((t) => t.id),
    ['foreign'],
  );
});
