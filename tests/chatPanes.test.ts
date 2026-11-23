import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatPaneForView, parkChatPane, chatTabsFor, type ChatPaneState } from '../src/store/chatPanes.ts';
import type { PaneTab } from '../src/store/state';
import type { Route } from '../src/store/types.ts';
import { focusPrimary } from '../src/store/split.ts';

/** A navigation of the primary pane, which focuses it. */
const forRoute = (s: ChatPaneState, route: Route, chatOf?: (id: string) => string) =>
  chatPaneForView(s, { route, split: focusPrimary(s.split) }, chatOf);

const thread = (id: string): Route => ({ name: 'thread', id });
const chat = (sourceChatId = 'a', id = `side-${sourceChatId}`): PaneTab => ({ id, kind: 'chat', threadId: `thread-${id}`, sourceChatId });
const browser: PaneTab = { id: 'browser', kind: 'browser', url: 'https://example.com' };
function state(extra: Partial<ChatPaneState> = {}): ChatPaneState {
  return {
    route: thread('a'),
    paneTabs: [chat()],
    paneActive: 'side-a',
    chatPanes: {},
    diffPanel: { open: true },
    paneFull: false,
    summaryOpen: true,
    ...extra,
  };
}
function go(s: ChatPaneState, route: Route): ChatPaneState {
  return { ...s, ...forRoute(s, route), route };
}

test('switching parents hides the previous side chat and returning restores its selected tab and full view', () => {
  const a = state({ paneFull: true });
  const b = go(a, thread('b'));
  assert.deepEqual(b.paneTabs, []);
  assert.equal(b.paneActive, '');
  assert.equal(b.diffPanel.open, false);
  assert.equal(b.paneFull, false);
  assert.deepEqual(b.chatPanes.a.tabs, a.paneTabs);
  const restored = go(b, thread('a'));
  assert.deepEqual(restored.paneTabs, a.paneTabs);
  assert.equal(restored.paneActive, 'side-a');
  assert.equal(restored.diffPanel.open, true);
  assert.equal(restored.paneFull, true);
  assert.deepEqual(a.chatPanes, {}, 'navigation does not mutate the previous state');
});

test('each session restores its own chat tabs, including sub-agent tabs, on forward and backward navigation', () => {
  let s = go(state(), thread('b'));
  const bTabs = [chat('b'), { ...chat('b', 'agent'), readOnly: true }];
  s = { ...s, paneTabs: bTabs, paneActive: 'agent', diffPanel: { open: true } };
  s = go(s, thread('a'));
  assert.deepEqual(s.paneTabs, [chat()]);
  s = go(s, thread('b'));
  assert.deepEqual(s.paneTabs, bTabs);
  assert.equal(s.paneActive, 'agent');
});

test('navigation through home and settings parks chats and restores them only with their parent', () => {
  let s = go(state(), { name: 'home' });
  assert.deepEqual(s.paneTabs, []);
  assert.deepEqual(forRoute(s, { name: 'settings' }), {});
  s = go(s, { name: 'settings' });
  s = go(s, thread('b'));
  assert.deepEqual(s.paneTabs, []);
  s = go(s, thread('a'));
  assert.deepEqual(s.paneTabs, [chat()]);
  assert.deepEqual(forRoute(s, thread('a')), {});
});

test('unowned browser, file and terminal tabs stay reachable without opening another session’s pane', () => {
  const globals: PaneTab[] = [browser, { id: 'file', kind: 'file' }, { id: 'terminal', kind: 'terminal' }];
  const a = state({ paneTabs: [...globals, chat()], paneFull: true, diffPanel: { open: true, file: '/repo/a.ts' } });
  const b = go(a, thread('b'));
  assert.deepEqual(b.paneTabs, globals);
  assert.equal(b.paneActive, 'terminal');
  assert.deepEqual(b.diffPanel, { open: false });
  assert.equal(b.paneFull, false);
  const restored = go(b, thread('a'));
  assert.deepEqual(restored.paneTabs, [...globals, chat()]);
  assert.equal(restored.paneActive, 'side-a');
});

test('an active unowned tab restores only its own session’s open and full-view state', () => {
  const b = go(state({ paneTabs: [browser, chat()], paneActive: 'browser', paneFull: true }), thread('b'));
  assert.equal(b.paneActive, 'browser');
  assert.equal(b.diffPanel.open, false);
  assert.equal(b.paneFull, false);
  const a = go(b, thread('a'));
  assert.equal(a.paneActive, 'browser');
  assert.equal(a.diffPanel.open, true);
  assert.equal(a.paneFull, true);
  assert.deepEqual(a.paneTabs, [browser, chat()]);
});

test('Changes targets, closed panes and summary visibility are restored independently by session', () => {
  const changes: PaneTab = { id: 'diff', kind: 'changes' };
  let s = state({
    paneTabs: [changes],
    paneActive: 'diff',
    summaryOpen: false,
    diffPanel: { open: true, file: '/repo/a.ts', scope: 'turn', turnId: 'a-turn' },
  });
  s = go(s, thread('claude:b'));
  assert.equal(s.diffPanel.open, false);
  assert.equal(s.summaryOpen, true);
  s = { ...s, summaryOpen: true, diffPanel: { open: false, file: '/repo/b.ts', scope: 'branch' } };
  s = go(s, thread('a'));
  assert.deepEqual(s.diffPanel, { open: true, file: '/repo/a.ts', scope: 'turn', turnId: 'a-turn' });
  assert.equal(s.summaryOpen, false);
  s = go(s, thread('claude:b'));
  assert.deepEqual(s.diffPanel, { open: false, file: '/repo/b.ts', scope: 'branch' });
  assert.equal(s.summaryOpen, true);
});

test('a saved closed pane stays closed even when its selected tab was removed', () => {
  const s = state({
    paneTabs: [browser],
    paneActive: 'browser',
    chatPanes: {
      b: { tabs: [], active: 'removed', open: false, full: true },
    },
  });
  const b = go(s, thread('b'));
  assert.equal(b.paneActive, 'browser');
  assert.equal(b.diffPanel.open, false);
  assert.equal(b.paneFull, false);
});

test('home does not inherit a session’s open pane and opaque session IDs keep distinct snapshots', () => {
  const id = 'acp:session/"a\\b';
  const s = state({ route: thread(id), paneTabs: [browser], paneActive: 'browser' });
  const home = go(s, { name: 'home' });
  assert.equal(home.diffPanel.open, false);
  assert.equal(go(home, thread(`${id}:other`)).diffPanel.open, false);
  assert.equal(go(home, thread(id)).diffPanel.open, true);
});

test('a hidden side chat stays hidden when returning, even if another session opened the pane', () => {
  let s = go(state({ diffPanel: { open: false } }), thread('b'));
  s = { ...s, paneTabs: [browser], paneActive: 'browser', diffPanel: { open: true } };
  s = go(s, thread('a'));
  assert.deepEqual(s.paneTabs, [browser, chat()]);
  assert.equal(s.diffPanel.open, false);
  assert.equal(s.paneFull, false);
});

test('closed chat tabs do not reappear from an older saved snapshot', () => {
  let s = go(go(state(), thread('b')), thread('a'));
  s = { ...s, paneTabs: [], paneActive: '', diffPanel: { open: false } };
  s = go(go(s, thread('b')), thread('a'));
  assert.deepEqual(s.paneTabs, []);
  assert.equal(s.paneActive, '');
  assert.equal(s.diffPanel.open, false);
});

test('a stale saved active tab falls back to the active global tab', () => {
  const s = state({
    paneTabs: [browser],
    paneActive: 'browser',
    chatPanes: { b: { tabs: [chat('b')], active: 'closed', open: true, full: false } },
  });
  const b = go(s, thread('b'));
  assert.deepEqual(b.paneTabs, [browser, chat('b')]);
  assert.equal(b.paneActive, 'browser');
});

test('fork completion after a session switch is parked without hijacking the current pane', () => {
  const b = go(state({ paneTabs: [browser, chat()] }), thread('b'));
  const next = { ...b, ...parkChatPane(b, chat('a', 'new-side')) };
  assert.deepEqual(next.paneTabs, [browser]);
  assert.equal(next.paneActive, b.paneActive);
  assert.equal(next.diffPanel.open, b.diffPanel.open);
  assert.deepEqual(next.chatPanes.a.tabs, [chat(), chat('a', 'new-side')]);
  const a = go(next, thread('a'));
  assert.equal(a.paneActive, 'new-side');
  assert.equal(a.diffPanel.open, true);
  assert.equal(a.paneFull, false);
});

test('parking and refocusing an existing tab updates it without duplicating it', () => {
  const b = go(state(), thread('b'));
  const updated = { ...chat(), title: 'Updated' };
  const s = { ...b, ...parkChatPane(b, updated) };
  assert.deepEqual(s.chatPanes.a.tabs, [updated]);
  assert.equal(s.chatPanes.a.active, updated.id);
});

test('a fork from a blank tab can be parked while keeping another tab selected', () => {
  const blank = chat('a', 'blank');
  const s = state({ route: thread('b'), paneTabs: [blank, browser], paneActive: 'blank', paneFull: true });
  const next = { ...s, ...parkChatPane(s, blank) };
  assert.deepEqual(next.paneTabs, [browser]);
  assert.equal(next.paneActive, 'browser');
  assert.equal(next.diffPanel.open, true);
  assert.deepEqual(next.chatPanes.a.tabs, [blank]);
});

test('parking the last converted tab closes the empty pane and clears full view', () => {
  const tab = chat('a', 'blank');
  const s = state({ route: { name: 'home' }, paneTabs: [tab], paneActive: 'blank', paneFull: true });
  const next = { ...s, ...parkChatPane(s, tab) };
  assert.deepEqual(next.paneTabs, []);
  assert.equal(next.paneActive, '');
  assert.equal(next.diffPanel.open, false);
  assert.equal(next.paneFull, false);
  assert.equal(go(next, thread('a')).paneActive, 'blank');
});

test('current-parent and unowned tabs are never parked', () => {
  assert.equal(parkChatPane(state(), chat()), undefined);
  assert.equal(parkChatPane(state(), { id: 'legacy', kind: 'chat' }), undefined);
});

test('side-chat reuse reads visible tabs for the selected parent and saved tabs for other parents', () => {
  const s = go(state(), thread('b'));
  assert.deepEqual(chatTabsFor(s, 'a'), [chat()]);
  assert.strictEqual(chatTabsFor(s, 'b'), s.paneTabs);
  assert.deepEqual(chatTabsFor(s, 'unknown'), []);
  assert.deepEqual(chatTabsFor(go(s, { name: 'settings' }), 'a'), [chat()]);
});

const owned = (ownerChat: string, id = `term-${ownerChat}`): PaneTab => ({ id, kind: 'terminal', ownerChat });

test("a session's own browser and terminal tabs leave with it and come back with its front tab and view", () => {
  const a = state({ paneTabs: [browser, owned('a'), chat()], paneActive: 'term-a', paneFull: true });
  const b = go(a, thread('b'));
  assert.deepEqual(b.paneTabs, [browser, owned('a')], 'the terminal stays mounted for its own session');
  assert.equal(b.paneActive, 'browser');
  assert.equal(b.diffPanel.open, false, 'session b did not open the pane, so it stays closed');
  assert.equal(b.chatPanes.a.active, 'term-a');
  const back = go(b, thread('a'));
  assert.equal(back.paneActive, 'term-a');
  assert.equal(back.diffPanel.open, true);
  assert.equal(back.paneFull, true);
});

test("a pane showing only the previous session's tab is closed in a session that has none", () => {
  const a = state({ paneTabs: [owned('a')], paneActive: 'term-a', paneFull: true });
  const b = go(a, thread('b'));
  assert.equal(b.paneActive, '');
  assert.equal(b.diffPanel.open, false);
  assert.equal(b.paneFull, false);
  const c = go({ ...b, paneTabs: [...b.paneTabs, owned('b')], paneActive: 'term-b', diffPanel: { open: true } }, thread('a'));
  assert.equal(c.paneActive, 'term-a');
  assert.equal(go(c, thread('b')).paneActive, 'term-b');
});

test('a saved front tab that belongs to another session is not restored', () => {
  const s = state({
    paneTabs: [owned('c')],
    paneActive: '',
    chatPanes: { b: { tabs: [], active: 'term-c', open: true, full: false } },
  });
  assert.equal(go(s, thread('b')).paneActive, '');
});

test('fallback selects a parked chat when its saved active tab is gone and no global tab remains', () => {
  const s = state({
    paneTabs: [],
    paneActive: '',
    chatPanes: {
      b: { tabs: [chat('b')], active: 'gone', open: true, full: false },
    },
  });
  const b = go(s, thread('b'));
  assert.equal(b.paneActive, 'side-b');
  assert.equal(b.diffPanel.open, true);
});

test('agent browser and task tabs are visible only to their owner, including switched native sessions', () => {
  const browser: PaneTab = { id: 'agent', kind: 'browser', agentChat: 'old-native' };
  const tasks: PaneTab = { id: 'tasks', kind: 'tasks', threadId: 'a' };
  const s = state({ paneTabs: [browser, tasks], paneActive: 'agent', paneFull: true });
  const normalize = (id: string) => (id === 'old-native' ? 'a' : id);
  const b = { ...s, ...forRoute(s, thread('b'), normalize), route: thread('b') };
  assert.equal(b.paneActive, '');
  assert.equal(b.diffPanel.open, false);
  const a = { ...b, ...forRoute(b, thread('a'), normalize) };
  assert.equal(a.paneActive, 'agent');
  assert.equal(a.diffPanel.open, true);
});

test('a late side-chat fork preserves its parent’s Changes target and summary visibility', () => {
  const s = go(state({ summaryOpen: false, diffPanel: { open: true, file: '/a.ts' } }), thread('b'));
  const parked = { ...s, ...parkChatPane(s, chat('a', 'late')) };
  const back = go(parked, thread('a'));
  assert.equal(back.summaryOpen, false);
  assert.equal(back.diffPanel.file, '/a.ts');
});

test('closing a shared panel tab in another session cannot remove the original session’s tab', () => {
  for (const kind of ['changes', 'tasks'] as const) {
    const tab: PaneTab = { id: kind, kind, ...(kind === 'tasks' ? { threadId: 'a' } : {}) };
    let s = state({ paneTabs: [tab], paneActive: kind });
    s = go(s, thread('b'));
    s = { ...s, paneTabs: [], paneActive: '', diffPanel: { open: false } };
    const a = go(s, thread('a'));
    assert.deepEqual(a.paneTabs, [tab], `${kind} belongs to the session that opened it`);
    assert.equal(a.paneActive, kind);
    assert.equal(a.diffPanel.open, true);
  }
});

const files: PaneTab = { id: 'files', kind: 'files' };

test('Files open in front stays open in front in the next session, in full view too, and back again', () => {
  for (const paneFull of [false, true]) {
    const a = state({ paneTabs: [chat(), files], paneActive: 'files', paneFull });
    const b = go(a, thread('b'));
    assert.deepEqual(b.paneTabs, [files], "the window's Files tab, without a's side chat");
    assert.equal(b.paneActive, 'files');
    assert.equal(b.diffPanel.open, true);
    assert.equal(b.paneFull, paneFull);
    const back = go(b, thread('a'));
    assert.deepEqual(back.paneTabs, [files, chat()]);
    assert.equal(back.paneActive, 'files');
    assert.equal(back.diffPanel.open, true);
  }
});

test("Files left behind another tab, or in a closed pane, stays in the strip without opening the next session's pane", () => {
  for (const extra of [{ paneActive: 'side-a' }, { paneActive: 'files', diffPanel: { open: false } }]) {
    const b = go(state({ paneTabs: [chat(), files], ...extra }), thread('b'));
    assert.deepEqual(b.paneTabs, [files]);
    assert.equal(b.diffPanel.open, false);
  }
});

test('Files open in front does not carry onto home, which has no session, nor from home into a session', () => {
  const home = go(state({ paneTabs: [files], paneActive: 'files' }), { name: 'home' });
  assert.equal(home.diffPanel.open, false);
  assert.deepEqual(home.paneTabs, [files]);
  const c = go(home, thread('c'));
  assert.equal(c.diffPanel.open, false, 'nothing open on home, nothing carried');
});

test('Files closed in the next session stays closed back in the session it came from', () => {
  const a = state({ paneTabs: [files], paneActive: 'files' });
  const b = go(a, thread('b'));
  const closed = go({ ...b, diffPanel: { ...b.diffPanel, open: false } }, thread('a'));
  assert.deepEqual([closed.paneActive, closed.diffPanel.open], ['files', false]);
  // a session whose own tab was in front keeps its pane as it left it
  const c = go(state({ paneTabs: [chat()], paneActive: 'side-a' }), thread('c'));
  assert.equal(go(c, thread('a')).diffPanel.open, true);
});
