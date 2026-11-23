// The real store actions behind the pane tab menu (src/store/panes.ts): Close other tabs / Close tabs to the right,
// New tab to the right and Rename, over the tabs the chat on screen shows.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const ids = () => st().paneTabs.map((t: any) => t.id);

// chat c1 on screen: its own tabs, a global Changes tab, its agent's tab, and another chat's agent tab between them
const TABS = [
  { id: 'changes', kind: 'changes' },
  { id: 'b1', kind: 'browser', ownerChat: 'c1', title: 'One' },
  { id: 'other', kind: 'browser', agentChat: 'c2' },
  { id: 'agent', kind: 'browser', agentChat: 'c1' },
  { id: 't1', kind: 'terminal', ownerChat: 'c1' },
];
beforeEach(() => {
  resetState();
  set({ route: { name: 'thread', id: 'c1' }, paneTabs: TABS as any, paneActive: 't1', diffPanel: { open: true } });
});

test("Close other tabs closes every tab this chat's view shows but that one, keeps other chats' tabs and fronts it", () => {
  S.closeOtherPaneTabs('b1', 'others');
  assert.deepEqual(ids(), ['b1', 'other']);
  assert.equal(st().paneActive, 'b1');
});

test('Close tabs to the right closes only the shown tabs after it; a front tab left of it stays in front', () => {
  set({ paneActive: 'changes' });
  S.closeOtherPaneTabs('b1', 'right');
  assert.deepEqual(ids(), ['changes', 'b1', 'other']);
  assert.equal(st().paneActive, 'changes');
  // the front tab was to the right: the tab the menu was on comes to the front
  set({ paneTabs: TABS as any, paneActive: 't1' });
  S.closeOtherPaneTabs('agent', 'right');
  assert.deepEqual(ids(), ['changes', 'b1', 'other', 'agent']);
  assert.equal(st().paneActive, 'agent');
});

test('away from a chat the strip shows only tabs no chat owns, and only those close', () => {
  set({ route: { name: 'home' } as any, paneTabs: [...TABS, { id: 'global', kind: 'files' }] as any });
  S.closeOtherPaneTabs('changes', 'others');
  assert.deepEqual(ids(), ['changes', 'b1', 'other', 'agent', 't1']);
});

test("a tab the view does not show (another chat's, or one that went) closes nothing", () => {
  S.closeOtherPaneTabs('other', 'others');
  S.closeOtherPaneTabs('gone', 'right');
  assert.deepEqual(
    ids(),
    TABS.map((t) => t.id),
  );
  assert.equal(st().paneActive, 't1');
});

test("New tab to the right opens this chat's blank browser tab right after the tab, in front", () => {
  S.openBrowserTabAfter('b1');
  const added = st().paneTabs[2];
  assert.deepEqual(
    ids().filter((id: string) => id !== added.id),
    TABS.map((t) => t.id),
  );
  assert.equal(added.kind, 'browser');
  assert.equal(added.ownerChat, 'c1');
  assert.equal(added.url, undefined);
  assert.equal(st().paneActive, added.id);
  // after the last tab it is the last tab
  S.openBrowserTabAfter('t1');
  assert.equal(st().paneTabs.at(-1)!.id, st().paneActive);
  // a tab that closed before the menu acted opens nothing
  const before = ids();
  S.openBrowserTabAfter('gone');
  assert.deepEqual(ids(), before);
});

test("Rename gives the tab the user's name, trimmed; a blank name gives the page's title back", () => {
  S.renamePaneTab('b1', '  Reference  ');
  assert.equal(st().paneTabs[1].customTitle, 'Reference');
  assert.equal(st().paneTabs[1].title, 'One');
  S.renamePaneTab('b1', '   ');
  assert.equal(st().paneTabs[1].customTitle, undefined);
  assert.deepEqual(st().paneTabs[3], TABS[3]);
});

test('a file tab with unsaved edits closes, alone or with others, only once the user agrees to lose them', async () => {
  const { setFileDraft, hasDraft, resetFileDrafts } = await import('../src/lib/fileDrafts.ts');
  const answers: boolean[] = [];
  const original = (globalThis as any).window?.confirm;
  (globalThis as any).window ??= {};
  (globalThis as any).window.confirm = () => answers.shift() ?? false;
  try {
    const edited = { id: 'f1', kind: 'file', path: '/repo/a.ts', ownerChat: 'c1' };
    set({ paneTabs: [...TABS, edited] as any, paneActive: 'f1' });
    setFileDraft('/repo/a.ts', 'one', 'two');
    answers.push(false);
    S.closePaneTab('f1');
    assert.ok(ids().includes('f1'), 'no keeps the tab and its edit');
    answers.push(false);
    S.closeOtherPaneTabs('changes', 'others');
    assert.ok(ids().includes('f1') && ids().includes('b1'), 'no closes none of them');
    answers.push(true);
    S.closeOtherPaneTabs('t1', 'right');
    assert.ok(!ids().includes('f1'));
    assert.equal(hasDraft('/repo/a.ts'), false);
    // a file tab without edits, and every other tab, closes without asking
    set({ paneTabs: [...TABS, { ...edited, path: '/repo/b.ts' }, { id: 'f2', kind: 'file' }] as any });
    S.closePaneTab('f1');
    S.closePaneTab('f2');
    S.closePaneTab('b1');
    assert.deepEqual(ids(), ['changes', 'other', 'agent', 't1']);
  } finally {
    (globalThis as any).window.confirm = original;
    resetFileDrafts();
  }
});

test('a file reopened at one line marks that line, not the range an earlier open left on its tab', () => {
  set({ paneTabs: [] as any });
  S.openPaneTab('file', { path: '/repo/a.ts', line: 5, endLine: 20 });
  S.openPaneTab('file', { path: '/repo/a.ts', line: 3 });
  const tab = st().paneTabs.find((t: any) => t.kind === 'file');
  assert.deepEqual([tab.line, tab.endLine], [3, undefined]);
  // an open without a line (show_pane without one) keeps where the tab was
  S.openPaneTab('file', { path: '/repo/a.ts', line: 5, endLine: 9 });
  S.openPaneTab('file', { path: '/repo/a.ts' });
  const kept = st().paneTabs.find((t: any) => t.kind === 'file');
  assert.deepEqual([kept.line, kept.endLine], [5, 9]);
});

test('closing a file tab while a Files tab still shows the file keeps its edit without asking', async () => {
  const { setFileDraft, hasDraft, resetFileDrafts } = await import('../src/lib/fileDrafts.ts');
  const { openWorkspaceFile, resetFilesWorkspaces } = await import('../src/lib/filesWorkspace.ts');
  (globalThis as any).window ??= {};
  const original = (globalThis as any).window.confirm;
  (globalThis as any).window.confirm = () => assert.fail('another view shows the file');
  try {
    set({ paneTabs: [...TABS, { id: 'f1', kind: 'file', path: '/repo/a.ts', ownerChat: 'c1' }] as any });
    setFileDraft('/repo/a.ts', 'one', 'two');
    openWorkspaceFile('/repo', '/repo/a.ts');
    S.closePaneTab('f1');
    assert.ok(!ids().includes('f1'));
    assert.equal(hasDraft('/repo/a.ts'), true);
  } finally {
    (globalThis as any).window.confirm = original;
    resetFileDrafts();
    resetFilesWorkspaces();
  }
});
