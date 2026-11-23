// Shared pane restoration uses the live focused view, retains resources and refuses missing or foreign explicit tabs.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
beforeEach(() => resetState());

test('restoring a hidden pane retains its older selected tab, hidden snapshot and resources on every harness', () => {
  for (const family of ['codex', 'claude', 'acp']) {
    const id = `${family}:chat`;
    const tabs = [
      { id: 'selected', kind: 'browser', ownerChat: id },
      { id: 'newer', kind: 'terminal', ownerChat: id },
      { id: 'foreign', kind: 'browser', ownerChat: 'other' },
    ];
    const hidden = { open: false, file: 'retained.ts', scope: 'branch', turnId: 'turn-1' };
    set({ route: { name: 'thread', id }, paneTabs: tabs as any, paneActive: 'selected', diffPanel: hidden });
    for (let n = 0; n < 3; n++) {
      S.showPaneTab();
      assert.equal(st().paneActive, 'selected');
      assert.equal(st().paneTabs, tabs);
      assert.deepEqual(st().diffPanel, { ...hidden, open: true });
      set({ diffPanel: hidden });
    }
  }
});

test('restore resolves missing or foreign selection through the live focused chat, including mixed split focus', () => {
  const tabs = [
    { id: 'mine', kind: 'browser', ownerChat: 'codex:a' },
    { id: 'foreign', kind: 'browser', ownerChat: 'claude:b' },
  ];
  set({ route: { name: 'thread', id: 'codex:a' }, paneTabs: tabs as any, diffPanel: { open: false } });
  for (const paneActive of ['removed', 'foreign']) {
    set({ paneActive });
    S.showPaneTab();
    assert.equal(st().paneActive, 'mine');
    assert.equal(st().paneTabs, tabs);
    set({ diffPanel: { open: false } });
  }
  set({ split: { panes: [{ chatId: 'claude:b', weight: 1 }], focus: 'claude:b', primaryWeight: 1 } });
  S.showPaneTab();
  assert.equal(st().paneActive, 'foreign');
  assert.equal(st().paneTabs, tabs);
});

test('restoration refuses an explicit retired or foreign tab and an empty view without creating resources', () => {
  set({
    route: { name: 'thread', id: 'codex:a' },
    paneTabs: [{ id: 'foreign', kind: 'browser', ownerChat: 'claude:b' }] as any,
    paneActive: 'foreign',
    diffPanel: { open: false },
  });
  const before = st();
  S.showPaneTab('removed');
  S.showPaneTab('foreign');
  S.showPaneTab();
  assert.equal(st(), before);
  set({ paneTabs: [] });
  const empty = st();
  S.showPaneTab();
  assert.equal(st(), empty);
});

test('an explicitly selected agent tab still fronts its page and opens the pane through the shared action', () => {
  const tab = { id: 'agent', kind: 'browser', agentChat: 'claude:a' };
  set({ route: { name: 'thread', id: 'claude:a' }, paneTabs: [tab] as any, diffPanel: { open: false } });
  S.selectAgentBrowserTab('claude:a', null);
  assert.equal(st().paneActive, 'agent');
  assert.equal(st().diffPanel.open, true);
});
