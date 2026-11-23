import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl } from './support/store-harness.ts';

// The real agent-tab functions of src/store/store.ts. What they hand to openPaneTab / closePaneTab is
// read off the state change and recorded in fixture.calls, as [name, ...args].
const { store, resetState } = await loadStore();
const fixture: { readonly state: any; calls: any[] } = {
  get state() {
    return store.useStore.getState();
  },
  calls: [],
};
function track<A extends any[]>(fn: (...args: A) => void) {
  return (...args: A) => {
    const before = store.useStore.getState();
    fn(...args);
    const after = store.useStore.getState();
    const ids = new Set(after.paneTabs.map((t: any) => t.id));
    for (const t of before.paneTabs) if (!ids.has(t.id)) fixture.calls.push(['closePaneTab', t.id]);
    const added = after.paneTabs.filter((t: any) => !before.paneTabs.some((b: any) => b.id === t.id));
    // openPaneTab fronts the tab it adds; a background mount leaves the front tab alone
    for (const { id, kind, ...extra } of added) if (after.paneActive === id) fixture.calls.push(['openPaneTab', kind, extra]);
  };
}
const m = {
  openAgentBrowserTab: track(store.openAgentBrowserTab),
  closeAgentBrowserTab: track(store.closeAgentBrowserTab),
  selectAgentBrowserTab: track(store.selectAgentBrowserTab),
};

const original = { id: 'browser-a', kind: 'browser', agentChat: 'chat1' };
const second = { id: 'browser-tab_aa1111', kind: 'browser', agentChat: 'chat1', agentTab: 'tab_aa1111' };
const otherChat = { id: 'browser-b', kind: 'browser', agentChat: 'chat2' };
const plain = { id: 'browser-plain', kind: 'browser' };
const terminal = { id: 'terminal-1', kind: 'terminal', agentChat: 'chat1' };

function reset(patch: any = {}) {
  // the window shows chat1 unless a test says otherwise
  resetState();
  store.useStore.setState({
    route: { name: 'thread', id: 'chat1' },
    paneTabs: [],
    paneActive: 'changes',
    diffPanel: { open: false, file: 'kept.ts' },
    threads: {},
    segments: {},
    ...patch,
  });
  fixture.calls = [];
}
beforeEach(() => reset());

test('openAgentBrowserTab focuses the chat original tab and opens the pane, keeping its other settings', () => {
  reset({ paneTabs: [plain, second, original, otherChat] });
  m.openAgentBrowserTab('chat1');
  assert.equal(fixture.state.paneActive, 'browser-a');
  assert.deepEqual(fixture.state.diffPanel, { open: true, file: 'kept.ts' });
  assert.equal(fixture.state.paneTabs.length, 4);
  assert.deepEqual(fixture.calls, []);
});

test('openAgentBrowserTab with no tabKey falls back to any tab of the chat when it has no original tab', () => {
  reset({ paneTabs: [terminal, otherChat, second] });
  m.openAgentBrowserTab('chat1', { tabKey: null });
  assert.equal(fixture.state.paneActive, 'browser-tab_aa1111');
  assert.equal(fixture.state.diffPanel.open, true);
});

test('openAgentBrowserTab with a tabKey focuses the matching tab, not the original', () => {
  reset({ paneTabs: [original, second], diffPanel: { open: true } });
  m.openAgentBrowserTab('chat1', { tabKey: 'tab_aa1111', focus: false });
  assert.equal(fixture.state.paneActive, 'browser-tab_aa1111');
  assert.deepEqual(fixture.calls, []);
});

test('openAgentBrowserTab with an unknown tabKey opens a new pane tab carrying the key and the chat name', () => {
  reset({ paneTabs: [original], threads: { chat1: { name: 'Fix login' } } });
  m.openAgentBrowserTab('chat1', { tabKey: 'tab_bb2222' });
  assert.deepEqual(fixture.calls, [
    ['openPaneTab', 'browser', { url: 'about:blank', title: 'Fix login', agentChat: 'chat1', agentTab: 'tab_bb2222' }],
  ]);
  assert.equal(fixture.state.paneActive, fixture.state.paneTabs.at(-1).id);
});

test('openAgentBrowserTab titles a tab with the chat a switched native session belongs to', () => {
  reset({ threads: { chat1: { name: 'Switched chat' } }, segments: { chat1: [{ nativeId: 'claude:abc' }] } });
  m.openAgentBrowserTab('claude:abc');
  assert.deepEqual(fixture.calls, [['openPaneTab', 'browser', { url: 'about:blank', title: 'Switched chat', agentChat: 'claude:abc' }]]);
});

test('openAgentBrowserTab without a chat name titles the tab Agent browser and leaves out an empty key', () => {
  reset({ paneTabs: [otherChat, plain], threads: { chat1: { name: '' } } });
  m.openAgentBrowserTab('chat1', { tabKey: '' });
  assert.deepEqual(fixture.calls, [['openPaneTab', 'browser', { url: 'about:blank', title: 'Agent browser', agentChat: 'chat1' }]]);
  reset({ route: { name: 'thread', id: 'chat3' } });
  m.openAgentBrowserTab('chat3');
  assert.deepEqual(fixture.calls, [['openPaneTab', 'browser', { url: 'about:blank', title: 'Agent browser', agentChat: 'chat3' }]]);
});

test('openAgentBrowserTab focus:false mounts a background tab when the pane is open and has tabs', () => {
  reset({ paneTabs: [original], paneActive: 'browser-a', diffPanel: { open: true }, threads: { chat1: { name: 'Task' } } });
  m.openAgentBrowserTab('chat1', { tabKey: 'tab_cc3333', focus: false });
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.state.paneActive, 'browser-a');
  assert.deepEqual(fixture.state.diffPanel, { open: true });
  assert.deepEqual(fixture.state.paneTabs, [
    original,
    { id: fixture.state.paneTabs[1].id, kind: 'browser', url: 'about:blank', title: 'Task', agentChat: 'chat1', agentTab: 'tab_cc3333' },
  ]);
});

test('openAgentBrowserTab places a duplicate right after its source tab, in the background or in front (#1362)', () => {
  const keys = () => fixture.state.paneTabs.map((t: any) => t.agentTab ?? t.id);
  // in the background, after a source named by its key
  reset({ paneTabs: [original, second, otherChat], paneActive: 'browser-a', diffPanel: { open: true } });
  m.openAgentBrowserTab('chat1', { tabKey: 'tab_ee5555', focus: false, after: 'tab_aa1111' });
  assert.deepEqual(keys(), ['browser-a', 'tab_aa1111', 'tab_ee5555', 'browser-b']);
  assert.equal(fixture.state.paneActive, 'browser-a');
  // in front (the pane was closed), after the chat's original tab (null)
  reset({ paneTabs: [original, second], diffPanel: { open: false } });
  m.openAgentBrowserTab('chat1', { tabKey: 'tab_ee5555', focus: false, after: null });
  assert.deepEqual(keys(), ['browser-a', 'tab_ee5555', 'tab_aa1111']);
  assert.equal(fixture.state.paneTabs[1].id, fixture.state.paneActive);
  // a source no longer in the pane leaves the new tab at the end
  reset({ paneTabs: [second], paneActive: 'browser-tab_aa1111', diffPanel: { open: true } });
  m.openAgentBrowserTab('chat1', { tabKey: 'tab_ee5555', focus: false, after: 'tab_ff6666' });
  assert.deepEqual(keys(), ['tab_aa1111', 'tab_ee5555']);
  // an existing tab is only shown, never moved
  reset({ paneTabs: [second, original], diffPanel: { open: true } });
  m.openAgentBrowserTab('chat1', { tabKey: 'tab_aa1111', focus: false, after: null });
  assert.deepEqual(keys(), ['tab_aa1111', 'browser-a']);
});

test('openAgentBrowserTab focus:false still opens a focused pane tab when it cannot mount in the background', () => {
  const cases = [
    { name: 'pane closed', state: { paneTabs: [otherChat], diffPanel: { open: false } }, opts: { tabKey: 'tab_dd4444', focus: false } },
    { name: 'no tabs', state: { paneTabs: [], diffPanel: { open: true } }, opts: { tabKey: 'tab_dd4444', focus: false } },
    { name: 'no tabKey', state: { paneTabs: [otherChat], diffPanel: { open: true } }, opts: { focus: false } },
    { name: 'focus true', state: { paneTabs: [otherChat], diffPanel: { open: true } }, opts: { tabKey: 'tab_dd4444', focus: true } },
  ];
  for (const c of cases) {
    reset(c.state);
    m.openAgentBrowserTab('chat1', c.opts);
    assert.equal(fixture.calls.length, 1, c.name);
    assert.equal(fixture.calls[0][0], 'openPaneTab', c.name);
    assert.equal(fixture.calls[0][2].agentTab, c.opts.tabKey, c.name);
    assert.deepEqual(fixture.state.paneTabs.slice(0, -1), c.state.paneTabs, c.name);
  }
});

test('closeAgentBrowserTab closes the original tab for null and the keyed tab for a key', () => {
  reset({ paneTabs: [second, original, otherChat] });
  m.closeAgentBrowserTab('chat1', null);
  m.closeAgentBrowserTab('chat1', 'tab_aa1111');
  assert.deepEqual(fixture.calls, [
    ['closePaneTab', 'browser-a'],
    ['closePaneTab', 'browser-tab_aa1111'],
  ]);
});

test('closeAgentBrowserTab does nothing when the chat has no such tab', () => {
  reset({ paneTabs: [second, otherChat, plain] });
  m.closeAgentBrowserTab('chat1', null);
  m.closeAgentBrowserTab('chat1', 'tab_missing');
  m.closeAgentBrowserTab('chat9', 'tab_aa1111');
  assert.deepEqual(fixture.calls, []);
});

test('selectAgentBrowserTab fronts the original or keyed tab and opens the pane', () => {
  reset({ paneTabs: [original, second], paneActive: 'browser-a', diffPanel: { open: false, file: 'x' } });
  m.selectAgentBrowserTab('chat1', 'tab_aa1111');
  assert.equal(fixture.state.paneActive, 'browser-tab_aa1111');
  assert.deepEqual(fixture.state.diffPanel, { open: true, file: 'x' });
  m.selectAgentBrowserTab('chat1', null);
  assert.equal(fixture.state.paneActive, 'browser-a');
});

test('selectAgentBrowserTab leaves the pane alone when the tab is missing', () => {
  reset({ paneTabs: [second, otherChat], paneActive: 'browser-b', diffPanel: { open: false } });
  const before = fixture.state;
  m.selectAgentBrowserTab('chat1', null);
  m.selectAgentBrowserTab('chat1', 'tab_missing');
  assert.equal(fixture.state, before);
});

// agentTabRequest (src/App.tsx) is tested through the menu commands in tests/appShell.test.ts

/* ---------- a chat's agent tabs belong to its own view ---------- */

test("openAgentBrowserTab for a chat the window doesn't show mounts the tab and leaves this view's pane as it is", () => {
  // the on-screen chat's pane is closed: another chat's agent opening a tab must not open it (nor Changes with it)
  reset({ route: { name: 'thread', id: 'chat2' }, paneTabs: [otherChat], paneActive: 'browser-b', threads: { chat1: { name: 'Task' } } });
  m.openAgentBrowserTab('chat1', { tabKey: 'tab_ee5555', focus: true });
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.state.paneActive, 'browser-b', "chat2's tab stays in front");
  assert.deepEqual(fixture.state.diffPanel, { open: false, file: 'kept.ts' });
  assert.deepEqual(fixture.state.paneTabs.at(-1), {
    id: fixture.state.paneTabs.at(-1).id,
    kind: 'browser',
    url: 'about:blank',
    title: 'Task',
    agentChat: 'chat1',
    agentTab: 'tab_ee5555',
  });
  // the chat's original tab (no key) too, on a page that shows no chat
  reset({ route: { name: 'home' } });
  m.openAgentBrowserTab('chat1');
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.state.paneActive, 'changes');
  assert.equal(fixture.state.diffPanel.open, false);
  assert.match(fixture.state.paneTabs[0].id, /^browser-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(fixture.state.paneTabs[0].agentTab, undefined);
});

test('openAgentBrowserTab for an existing tab of a chat the window does not show changes nothing on screen', () => {
  reset({ route: { name: 'thread', id: 'chat2' }, paneTabs: [original, otherChat], paneActive: 'browser-b', diffPanel: { open: false } });
  m.openAgentBrowserTab('chat1');
  assert.equal(fixture.state.paneActive, 'browser-b');
  assert.deepEqual(fixture.state.diffPanel, { open: false });
  assert.equal(fixture.state.paneTabs.length, 2);
});

test("with <webview> tabs (views off) another chat's tab still opens the pane, as its page attaches only there", (t) => {
  const was = impl['flags.isEnabled'];
  impl['flags.isEnabled'] = (key: string) => key !== 'shared.browser.viewTabs';
  t.after(() => (impl['flags.isEnabled'] = was));
  reset({ route: { name: 'thread', id: 'chat2' }, paneTabs: [otherChat], paneActive: 'browser-b' });
  // a button would change what the user sees there: the pane opens
  assert.equal(store.agentBrowserTabOpens(fixture.state, 'chat1'), true);
  m.openAgentBrowserTab('chat1', { tabKey: 'tab_ee5555' });
  assert.equal(store.agentBrowserTabOpens(fixture.state, 'chat1'), false);
  assert.equal(fixture.state.paneActive, 'browser-b');
  assert.deepEqual(fixture.state.diffPanel, { open: true, file: 'kept.ts' });
  reset({ route: { name: 'thread', id: 'chat2' }, paneTabs: [original, otherChat], paneActive: 'browser-b' });
  m.openAgentBrowserTab('chat1');
  assert.equal(fixture.state.paneActive, 'browser-b');
  assert.deepEqual(fixture.state.diffPanel, { open: true, file: 'kept.ts' });
});

test("a side chat's agent tabs show in the view of the chat whose pane holds it; a switched session maps to its chat", () => {
  const side = { id: 'chat-side', kind: 'chat', threadId: 'side1' };
  reset({ route: { name: 'thread', id: 'chat2' }, paneTabs: [side], threads: { side1: { name: 'Side' } } });
  m.openAgentBrowserTab('side1', { tabKey: 'tab_ff6666' });
  assert.deepEqual(fixture.calls, [
    ['openPaneTab', 'browser', { url: 'about:blank', title: 'Side', agentChat: 'side1', agentTab: 'tab_ff6666' }],
  ]);
  reset({
    route: { name: 'thread', id: 'chat1' },
    segments: { chat1: [{ nativeId: 'claude:abc' }] },
    paneTabs: [{ id: 'browser-x', kind: 'browser', agentChat: 'claude:abc', agentTab: 'tab_aa1111' }],
  });
  m.selectAgentBrowserTab('claude:abc', 'tab_aa1111');
  assert.equal(fixture.state.paneActive, 'browser-x');
});

test("selectAgentBrowserTab never shows a tab in another chat's view", () => {
  reset({ route: { name: 'thread', id: 'chat2' }, paneTabs: [original, otherChat], paneActive: 'browser-b', diffPanel: { open: true } });
  const before = fixture.state;
  m.selectAgentBrowserTab('chat1', null);
  assert.equal(fixture.state, before);
  reset({ route: { name: 'home' }, paneTabs: [original], paneActive: 'changes', diffPanel: { open: true } });
  m.selectAgentBrowserTab('chat1', null);
  assert.equal(fixture.state.paneActive, 'changes');
});

test("closing the last tab in view hides the pane and keeps other chats' agent tabs", () => {
  reset({ paneTabs: [{ id: 'changes', kind: 'changes' }, otherChat], paneActive: 'changes', diffPanel: { open: true } });
  store.closePaneTab('changes');
  assert.deepEqual(fixture.state.paneTabs, [otherChat]);
  assert.equal(fixture.state.paneActive, '');
  assert.deepEqual(fixture.state.diffPanel, { open: false });
  // the new-chat page shows no chat's agent tabs either
  reset({
    route: { name: 'home' },
    paneTabs: [{ id: 'changes', kind: 'changes' }, original],
    paneActive: 'changes',
    diffPanel: { open: true },
  });
  store.closePaneTab('changes');
  assert.deepEqual([fixture.state.paneTabs, fixture.state.diffPanel.open], [[original], false]);
});

test('closing a tab while another stays in view keeps the pane open', () => {
  reset({ paneTabs: [{ id: 'changes', kind: 'changes' }, otherChat, original], paneActive: 'changes', diffPanel: { open: true } });
  store.closePaneTab('changes');
  assert.equal(fixture.state.paneActive, 'browser-a');
  assert.equal(fixture.state.diffPanel.open, true);
});

test('background agent tabs stay distinct across chats and native keys', (t) => {
  t.mock.method(Date, 'now', () => 1700000000000);
  for (const tabKey of [undefined, 'shared-native-key']) {
    reset({ route: { name: 'home' }, paneTabs: [], paneActive: '' });
    m.openAgentBrowserTab('chat1', { tabKey });
    m.openAgentBrowserTab('chat2', { tabKey });
    const [first, second] = fixture.state.paneTabs;
    assert.notEqual(first.id, second.id);
    m.openAgentBrowserTab('chat1', { tabKey });
    assert.equal(fixture.state.paneTabs.length, 2);
    m.closeAgentBrowserTab('chat1', tabKey ?? null);
    assert.deepEqual(
      fixture.state.paneTabs.map((tab: any) => tab.id),
      [second.id],
    );
    assert.equal(fixture.state.paneTabs[0].agentChat, 'chat2');
  }
});

test("an agent tab in front of this view's open pane is marked seen once; another view's or a closed pane's is not", async () => {
  const { seenPatch } = await import('../src/store/panes.ts');
  const base = { route: { name: 'thread', id: 'chat1' }, paneActive: 'browser-a', diffPanel: { open: true } } as any;
  assert.deepEqual(seenPatch({ ...base, paneTabs: [original] }), { paneTabs: [{ ...original, seen: true }] });
  assert.equal(seenPatch({ ...base, paneTabs: [{ ...original, seen: true }] }), null, 'already seen');
  assert.equal(seenPatch({ ...base, paneTabs: [original], diffPanel: { open: false } }), null, 'pane closed');
  assert.equal(seenPatch({ ...base, paneTabs: [plain], paneActive: 'browser-plain' }), null, "the user's own tab");
  assert.equal(seenPatch({ ...base, paneTabs: [otherChat], paneActive: 'browser-b' }), null, "another chat's tab is not in front here");
  assert.equal(seenPatch({ ...base, paneTabs: [] }), null);
  assert.equal(seenPatch({ ...base, paneTabs: [original], route: { name: 'settings' } }), null, 'no pane is drawn on Settings');
  // the store marks it as soon as it is in front of the open pane (its subscription, which the app starts at boot)
  const { startAgentTabs } = await import('../src/store/panes.ts');
  startAgentTabs();
  m.openAgentBrowserTab('chat1');
  assert.equal(fixture.state.paneTabs[0].seen, true);
  // a store change that leaves the pane's view as it was is not looked at again (a streaming reply's updates)
  store.useStore.setState({ paneTabs: [{ ...original, id: 'browser-z' }] as any });
  store.useStore.setState({ threads: { chat1: { name: 'renamed' } } } as any);
  assert.equal(fixture.state.paneTabs[0].seen, true, 'a new tab list is looked at');
  const tabs = fixture.state.paneTabs;
  store.useStore.setState({ segments: {} });
  assert.equal(fixture.state.paneTabs, tabs);
});

test("automatic requests front a seen tab only while the pane is open; a closed pane stays the user's", () => {
  const seen = { ...original, seen: true };
  // closed by the user after seeing it: the agent's reveal, its result and browser_tabs_select leave it closed
  reset({ paneTabs: [seen, second], paneActive: 'browser-tab_aa1111', diffPanel: { open: false } });
  m.openAgentBrowserTab('chat1', { auto: true });
  m.selectAgentBrowserTab('chat1', null, true);
  assert.deepEqual(fixture.state.diffPanel, { open: false });
  assert.equal(fixture.state.paneActive, 'browser-tab_aa1111');
  // a tab never seen still opens the pane once
  m.openAgentBrowserTab('chat1', { tabKey: 'tab_aa1111', auto: true });
  assert.equal(fixture.state.diffPanel.open, true);
  assert.equal(fixture.state.paneActive, 'browser-tab_aa1111');
  // while the pane is open the agent's pace still moves the front tab
  m.selectAgentBrowserTab('chat1', null, true);
  assert.equal(fixture.state.paneActive, 'browser-a');
  // what the user or a hand-off asks for shows the tab whatever was seen
  reset({ paneTabs: [seen], diffPanel: { open: false } });
  m.selectAgentBrowserTab('chat1', null);
  assert.equal(fixture.state.diffPanel.open, true);
  reset({ paneTabs: [seen], diffPanel: { open: false } });
  m.openAgentBrowserTab('chat1');
  assert.equal(fixture.state.diffPanel.open, true);
});

test('openAgentBrowserTab titles a Host chat’s desktop tab by its machine (and says so when the machine is not known yet)', () => {
  const key = JSON.stringify(['host', 'h1', 'desktop']);
  const view = { tabId: 'desktop', tabKey: key, kind: 'tab', active: true, takenOver: false, desktop: { machine: 'box' } };
  reset({ threads: { chat1: { name: 'Fix login' } }, agentTabs: { chat1: [view] } });
  m.openAgentBrowserTab('chat1', { tabKey: key });
  assert.deepEqual(fixture.calls, [
    ['openPaneTab', 'browser', { url: 'about:blank', title: 'Desktop on box', agentChat: 'chat1', agentTab: key, seen: true }],
  ]);
  reset({ threads: { chat1: { name: 'Fix login' } }, agentTabs: {} });
  m.openAgentBrowserTab('chat1', { tabKey: key });
  assert.equal((fixture.calls[0][2] as any).title, 'Desktop on the other machine');
  // a tab main lists without a machine says the same
  reset({ threads: { chat1: { name: 'Fix login' } }, agentTabs: { chat1: [{ ...view, desktop: undefined }] } });
  m.openAgentBrowserTab('chat1', { tabKey: key });
  assert.equal((fixture.calls[0][2] as any).title, 'Desktop on the other machine');
  // a Host's browser tab keeps the chat's name
  const page = JSON.stringify(['host', 'h1', 'tab_x']);
  reset({ threads: { chat1: { name: 'Fix login' } } });
  m.openAgentBrowserTab('chat1', { tabKey: page });
  assert.equal((fixture.calls[0][2] as any).title, 'Fix login');
});
