// Production navigation and tab actions preserve per-chat Changes, Files and Tasks panels across harness identities.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const state = () => S.useStore.getState();
beforeEach(() => {
  resetState();
  resetAll();
});

test('closing Changes in another chat cannot close the original panel through Back or Forward', () => {
  S.useStore.setState({
    route: { name: 'thread', id: 'a' },
    runtime: {
      a: { loaded: true } as any,
      'claude:b': { loaded: true } as any,
      'acp:c': { loaded: true } as any,
    },
    summaryOpen: false,
  });
  S.openChanges({ file: '/repo/a.ts', scope: 'turn', turnId: 'turn-a' });
  S.navigate({ name: 'thread', id: 'claude:b' });
  assert.equal(state().diffPanel.open, false);
  assert.equal(state().summaryOpen, true);
  S.openChanges({ scope: 'branch' });
  S.closePaneTab('changes');
  S.goBack();
  assert.deepEqual(state().diffPanel, { open: true, file: '/repo/a.ts', scope: 'turn', turnId: 'turn-a' });
  assert.equal(state().paneActive, 'changes');
  assert.equal(state().summaryOpen, false);
  S.goForward();
  assert.equal(state().diffPanel.open, false);
  assert.equal(
    state().paneTabs.some((tab) => tab.kind === 'changes'),
    false,
  );
  S.navigate({ name: 'thread', id: 'acp:c' });
  assert.equal(state().diffPanel.open, false);
});

test('the Tasks descriptor belongs to its session even when another chat replaces its own tab', () => {
  for (const kind of ['tasks'] as const) {
    resetState();
    S.useStore.setState({
      route: { name: 'thread', id: 'a' },
      runtime: {
        a: { loaded: true } as any,
        b: { loaded: true } as any,
      },
    });
    S.openPaneTab(kind, { threadId: 'a' });
    const original = state().paneTabs.find((tab) => tab.kind === kind)!;
    S.navigate({ name: 'thread', id: 'b' });
    assert.equal(state().diffPanel.open, false);
    S.openPaneTab(kind, { threadId: 'b' });
    S.goBack();
    assert.deepEqual(
      state().paneTabs.filter((tab) => tab.kind === kind),
      [original],
    );
    assert.equal(state().diffPanel.open, true);
    S.goForward();
    assert.equal(state().paneTabs.find((tab) => tab.kind === kind)?.threadId, 'b');
  }
});

test("the Files tab is the window's: open in front, it stays open through navigation to another session and back", () => {
  resetState();
  S.useStore.setState({ route: { name: 'thread', id: 'a' }, runtime: { a: { loaded: true } as any, b: { loaded: true } as any } });
  S.openPaneTab('files');
  S.navigate({ name: 'thread', id: 'b' });
  assert.deepEqual([state().paneActive, state().diffPanel.open], ['files', true]);
  S.goBack();
  assert.deepEqual([state().paneActive, state().diffPanel.open], ['files', true]);
  assert.equal(state().paneTabs.filter((tab) => tab.kind === 'files').length, 1);
});
