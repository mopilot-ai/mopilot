import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { pointerEvent } from './support/pointerCapture.ts';
import { fakeStore, one, render } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';
import { stubPanels } from './support/side-pane-panels.ts';

const store = fakeStore({ paneTabs: [], paneActive: null, paneFull: false, agentTabs: {}, segments: {} });
const calls: unknown[][] = [];
const exits: Record<string, () => void> = {};
let term: any = null;
const { createElement: h, act } = await import('react');
/** A stub panel: an element carrying its props (functions left out), so the test sees what the pane passed. */
const stub = (name: string, panel: string) => (props: any) =>
  h('section', {
    'data-stub': name,
    'data-panel': panel,
    'data-props': JSON.stringify(props, (k, v) => (typeof v === 'function' ? undefined : v)),
  });
stubStore({ ...store.exports, chatOf: (id: string) => store.get().alias?.[id] ?? id });
mock.module('../src/components/panels/DiffPanel.tsx', { namedExports: { DiffPanel: stub('diff', 'DiffPanel') } });
stubPanels(stub, [
  ['panels/PlanPanel.tsx', { PlanPanel: 'plan' }],
  ['panels/ArtifactPanel.tsx', { ArtifactPanel: 'artifact' }],
]);
mock.module('../src/components/panels/files/RemoteFiles.tsx', {
  namedExports: { RemoteFilesPanel: stub('remote-files', 'RemoteFilesPanel'), RemoteFilePreview: stub('remote-file', 'RemoteFilePreview') },
});
mock.module('../src/components/panels/TerminalPanel.tsx', {
  namedExports: {
    TermView: (p: any) => {
      exits[p.tab.id] = () => p.onExit(0);
      term = p;
      return h('section', {
        'data-stub': 'term',
        'data-panel': 'TermView',
        'data-visible': String(p.visible),
        'data-props': JSON.stringify(p, (k, v) => (typeof v === 'function' ? undefined : v)),
      });
    },
  },
});
mock.module('../src/session/harness/claude.ts', {
  namedExports: {
    recheckClaude: async () => {
      calls.push(['recheckClaude']);
    },
  },
});
const { SidePane } = await import('../src/components/panels/SidePane.tsx');
// The pane springs its width with element.animate (usePaneSpring, tested in paneSpring.test.ts). happy-dom's
// Animation rejects `finished` unhandled when cancelled, where browsers mark that rejection handled: an inert stand-in.
(globalThis as any).HTMLElement.prototype.animate = () => ({ cancel: () => undefined });

const observers: { cb: () => void; disconnected: boolean }[] = [];
(globalThis as any).ResizeObserver = class {
  entry: { cb: () => void; disconnected: boolean };
  constructor(cb: () => void) {
    this.entry = { cb, disconnected: false };
    observers.push(this.entry);
  }
  observe() {}
  disconnect() {
    this.entry.disconnected = true;
  }
};

beforeEach(() => {
  calls.length = 0;
  store.calls.length = 0;
  observers.length = 0;
  (window as any).innerWidth = 1600;
});
/** One animation frame: a drag shows its width once per frame (src/lib/edgeDrag.ts). */
const frame = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));
const props = (host: ParentNode, name: string) => JSON.parse(one(host as HTMLElement, `[data-stub="${name}"]`).getAttribute('data-props')!);
const stubs = (host: ParentNode) => [...host.querySelectorAll('[data-stub]')].map((e) => e.getAttribute('data-stub'));

test('a Plan tab passes its exact selection only while active and owned by a chat', async () => {
  const plan = { turnId: 'old', itemId: 'proposal' };
  store.set({
    paneTabs: [
      { id: 'plan', kind: 'plan', threadId: 't1', plan },
      { id: 'empty', kind: 'plan' },
    ],
    paneActive: 'plan',
    paneFull: false,
  });
  const r = await render(h(SidePane, { cwd: '/repo', threadId: 't1' }));
  assert.deepEqual(props(r.host, 'plan'), { threadId: 't1', plan });
  await act(() => store.set({ paneActive: 'empty' }));
  assert.equal(r.host.querySelector('[data-stub="plan"]'), null);
  await r.unmount();
});

test('an empty pane opens Changes, unless it is closing', async () => {
  store.set({ paneTabs: [], paneActive: null, paneFull: false });
  const r = await render(h(SidePane, { cwd: '/repo', threadId: 't1' }));
  assert.deepEqual(store.calls, [['openChanges']]);
  await r.unmount();
  store.calls.length = 0;
  const leaving = await render(h(SidePane, { cwd: '/repo', threadId: 't1', leaving: true }));
  assert.equal(one(leaving.host, '.side-pane').className, 'side-pane  leaving');
  assert.deepEqual(store.calls, []);
});

test('each tab kind renders its panel; only the active tool tabs mount, browsers and chats stay mounted', async () => {
  store.set({
    paneActive: 'c',
    paneTabs: [
      { id: 'c', kind: 'changes' },
      { id: 'f', kind: 'files' },
      { id: 'p', kind: 'file', path: '/repo/a.ts', line: 3 },
      { id: 'p2', kind: 'file' },
      { id: 's', kind: 'skill', path: '/skills/x/SKILL.md' },
      { id: 's2', kind: 'skill' },
      { id: 'ch', kind: 'chat', threadId: 'side', readOnly: true },
      { id: 'ch2', kind: 'chat', threadId: 'side2' },
      { id: 'ch3', kind: 'chat' },
      { id: 'b', kind: 'browser' },
      {
        id: 't',
        kind: 'terminal',
        cwd: '/tmp',
        title: 'claude auth login',
        command: ['claude', 'auth', 'login'],
        input: 'x',
        signIn: true,
      },
      { id: 't2', kind: 'terminal' },
    ],
  });
  const r = await render(h(SidePane, { cwd: '/repo', threadId: 't1' }));
  assert.deepEqual(stubs(r.host), ['diff', 'skill', 'thread', 'thread', 'browser', 'term', 'term']);
  assert.deepEqual(props(r.host, 'diff'), { cwd: '/repo', threadId: 't1' });
  assert.deepEqual(
    [...r.host.querySelectorAll('[data-stub="thread"]')].map((e) => JSON.parse(e.getAttribute('data-props')!)),
    [
      { threadId: 'side', inPane: true, readOnly: true },
      { threadId: 'side2', inPane: true, readOnly: false },
    ],
  );
  assert.deepEqual(props(r.host, 'browser'), { tabId: 'b', cwd: '/repo', threadId: 't1', layer: 'none' });
  assert.deepEqual(
    [...r.host.querySelectorAll('[data-stub="term"]')].map((e) => JSON.parse(e.getAttribute('data-props')!)),
    [
      {
        tab: { id: 't', cwd: '/tmp', title: 'claude auth login', command: ['claude', 'auth', 'login'], input: 'x', signIn: true },
        visible: false,
      },
      { tab: { id: 't2', cwd: '/repo', title: '' }, visible: false },
    ],
  );
  assert.deepEqual(
    [...r.host.querySelectorAll('.pane-tab-body')].map((b) => (b as HTMLElement).hidden),
    [false, true, true, true, true, true, true, true, true, true, true, true],
  );
  await act(async () => store.set({ paneActive: 'f' }));
  assert.equal(stubs(r.host)[0], 'files');
  await act(async () => store.set({ paneActive: 'p' }));
  assert.deepEqual(props(r.host, 'file'), { path: '/repo/a.ts', line: 3, cwd: '/repo' });
  await act(async () => store.set({ paneTabs: [{ id: 'p', kind: 'file', path: '/x/b.ts', cwd: '/x' }] }));
  assert.deepEqual(props(r.host, 'file'), { path: '/x/b.ts', cwd: '/x' });
});

test("the Background tasks tab shows its chat's tasks, only in that chat's view and only in front", async () => {
  store.set({ paneActive: 'k', paneTabs: [{ id: 'k', kind: 'tasks', threadId: 't1', views: [] }] });
  const r = await render(h(SidePane, { cwd: '/repo', threadId: 't1' }));
  assert.deepEqual(props(r.host, 'tasks'), {
    tab: { id: 'k', kind: 'tasks', threadId: 't1', views: [] },
    chatId: 't1',
    cwd: '/repo',
  });
  // behind another tab it is not painted
  await act(async () =>
    store.set({
      paneTabs: [
        { id: 'k', kind: 'tasks', threadId: 't1' },
        { id: 'c', kind: 'changes' },
      ],
      paneActive: 'c',
    }),
  );
  assert.deepEqual(stubs(r.host), ['diff']);
  // another chat's tasks tab is not this chat's: the pane falls back to Changes
  await act(async () =>
    store.set({
      paneActive: 'k',
      paneTabs: [
        { id: 'k', kind: 'tasks', threadId: 'other' },
        { id: 'c', kind: 'changes' },
      ],
    }),
  );
  assert.deepEqual(stubs(r.host), ['diff']);
  await r.unmount();
});

test('a finished terminal tab closes itself, and finishing a Claude sign-in rechecks Claude', async () => {
  store.set({
    paneActive: 'a',
    paneTabs: [
      { id: 'a', kind: 'terminal', title: 'claude auth login' },
      { id: 'b', kind: 'terminal', title: 'zsh' },
    ],
  });
  await render(h(SidePane, { cwd: '/repo', threadId: null }));
  await act(async () => exits.a());
  await act(async () => exits.b());
  assert.deepEqual(store.calls, [
    ['closePaneTab', 'a'],
    ['closePaneTab', 'b'],
  ]);
  assert.deepEqual(calls, [['recheckClaude']]);
});

test('the pane takes half the content lane, reports its width and resets on unmount', async () => {
  store.set({ paneActive: 'c', paneTabs: [{ id: 'c', kind: 'changes' }], paneFull: false });
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 1000 });
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 't1' })));
  const pane = one(host, '.side-pane');
  assert.equal(pane.style.width, '500px');
  assert.equal(pane.style.getPropertyValue('--pane-w'), '500px');
  pane.getBoundingClientRect = () => ({ width: 499.6 }) as DOMRect;
  observers[0].cb();
  assert.deepEqual(store.calls.at(-1), ['setState', { paneWidth: 500 }]);
  await act(async () => root.unmount());
  assert.equal(observers[0].disconnected, true);
  assert.deepEqual(store.calls.at(-1), ['setState', { paneWidth: 0, paneFull: false }]);
});

test('a lane that shrinks after the pane opened takes the pane in with it', async () => {
  store.set({ paneActive: 'c', paneTabs: [{ id: 'c', kind: 'changes' }], paneFull: false });
  const host = document.createElement('div');
  let lane = 1600;
  Object.defineProperty(host, 'clientWidth', { get: () => lane });
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 't1' })));
  const pane = one(host, '.side-pane');
  assert.equal(pane.style.width, '800px');
  // the window gets smaller: the observer fires and the pane no longer overruns the room
  lane = 416;
  pane.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
  await act(async () => observers[0].cb());
  assert.equal(pane.style.width, '198px');
  assert.equal(pane.style.getPropertyValue('--pane-w'), '198px');
  await act(async () => root.unmount());
});

test('full view floats the composer when there is a chat and drops the fixed width', async () => {
  store.set({ paneActive: 'c', paneTabs: [{ id: 'c', kind: 'changes' }], paneFull: true });
  const r = await render(h(SidePane, { cwd: '/repo', threadId: 't1' }));
  const pane = one(r.host, '.side-pane');
  assert.equal(pane.className, 'side-pane full ');
  assert.equal(pane.getAttribute('style'), null);
  assert.deepEqual(props(r.host, 'composer'), { threadId: 't1', variant: 'thread' });
  await r.unmount();
  const solo = await render(h(SidePane, { cwd: '/repo', threadId: null }));
  assert.equal(solo.host.querySelector('[data-stub="composer"]'), null);
});

/* ---- an agent's browser tabs belong to their own chat's view: another chat's tab is never shown, yet
   stays mounted, painted behind the pane while its agent drives it ---- */
let root: any;
let host: HTMLElement;
async function renderPane(state: any, p: any = {}) {
  store.calls.length = 0;
  store.set({
    paneTabs: [],
    paneActive: '',
    agentTabs: {},
    segments: {},
    paneFull: false,
    alias: undefined,
    paneWidth: undefined,
    ...state,
  });
  host = document.createElement('div');
  // the content lane the pane measures
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 1200 });
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 'chat-a', ...p })));
  return host;
}
const bodies = () => [...host.querySelectorAll<HTMLElement>('.pane-tab-body')];
const layerOf = (el: HTMLElement) => (el.classList.contains('pane-tab-back') ? 'back' : el.hidden ? 'none' : 'front');
const browserLayer = (el: HTMLElement) => JSON.parse(el.querySelector('[data-panel="BrowserPanel"]')!.getAttribute('data-props')!).layer;
const fixture = {
  update: (patch: any) => store.set(patch),
  get state() {
    return store.get();
  },
  get calls() {
    return store.calls;
  },
  get term() {
    return term;
  },
};
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  root = null;
});

const view = (patch: any = {}) => ({
  tabId: 'tab_1',
  tabKey: 'tab_1',
  kind: 'tab',
  active: true,
  created: true,
  mark: null,
  takenOver: false,
  origin: null,
  access: null,
  ...patch,
});

test("SidePane: another chat's agent tab is never shown, but stays mounted and is painted behind while its agent drives it", async () => {
  const tabs = [
    { id: 'mine', kind: 'browser', agentChat: 'chat-a', agentTab: 'tab_1' },
    { id: 'theirs', kind: 'browser', agentChat: 'chat-b', agentTab: 'tab_2' },
    { id: 'idle', kind: 'browser', agentChat: 'chat-b', agentTab: 'tab_3' },
    { id: 'changes', kind: 'changes' },
  ];
  await renderPane({
    paneTabs: tabs,
    paneActive: 'theirs',
    agentTabs: { 'chat-b': [view({ tabKey: 'tab_2', tabId: 'tab_2' }), view({ tabKey: 'tab_3', tabId: 'tab_3', active: false })] },
  });
  // chat-b's tab is the pane's active tab, but chat-a is on screen: the last tab in its view is in front
  assert.deepEqual(bodies().map(layerOf), ['none', 'back', 'none', 'front']);
  const back = bodies()[1];
  assert.equal(back.getAttribute('aria-hidden'), 'true');
  assert.equal(back.hasAttribute('inert'), true);
  assert.equal(browserLayer(back), 'back');
  assert.equal(browserLayer(bodies()[0]), 'none');
  assert.ok(host.querySelector('[data-panel="DiffPanel"]'), 'the front Changes tab renders');
  assert.deepEqual(fixture.calls, [], 'a tab is in view: no Changes tab is opened');
  // chat-b on screen: its tab is in front, chat-a's is not laid out
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 'chat-b' })));
  assert.deepEqual(bodies().map(layerOf), ['none', 'front', 'none', 'none']);
  assert.equal(browserLayer(bodies()[1]), 'front');
  assert.equal(bodies()[1].hasAttribute('aria-hidden'), false);
  // the agent lets go: nothing to paint behind any more
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: 'chat-a' })));
  await act(async () => fixture.update({ agentTabs: {} }));
  assert.deepEqual(bodies().map(layerOf), ['none', 'none', 'none', 'front']);
});

test("SidePane: a view with only other chats' tabs opens Changes; a switched session's and a side chat's tabs are in view", async () => {
  await renderPane({ paneTabs: [{ id: 'theirs', kind: 'browser', agentChat: 'chat-b' }], paneActive: 'theirs' });
  assert.deepEqual(fixture.calls, [['openChanges']]);
  assert.deepEqual(bodies().map(layerOf), ['none']);
  await act(async () => root.unmount());
  host.remove();
  await renderPane({
    paneTabs: [
      { id: 'switched', kind: 'browser', agentChat: 'claude:a' },
      { id: 'side', kind: 'chat', threadId: 'side-1' },
      { id: 'side-tab', kind: 'browser', agentChat: 'side-1' },
    ],
    paneActive: 'switched',
    alias: { 'claude:a': 'chat-a' },
  });
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(bodies().map(layerOf), ['front', 'none', 'none']);
  assert.ok(host.querySelector('[data-panel="ThreadView"]'), 'side chats stay mounted');
  // leaving: no Changes tab is opened for an empty view
  await act(async () => root.unmount());
  host.remove();
  await renderPane({ paneTabs: [] }, { leaving: true });
  assert.deepEqual(fixture.calls, []);
  assert.match(host.querySelector('.side-pane')!.className, /\bleaving\b/);
});

test('SidePane: every kind of tab renders only in front where it should, and a terminal follows the front tab', async () => {
  const tabs = [
    { id: 'files', kind: 'files' },
    { id: 'file', kind: 'file', path: '/repo/a.ts', line: 3 },
    { id: 'file-cwd', kind: 'file', path: '/repo/b.ts', cwd: '/other' },
    { id: 'nofile', kind: 'file' },
    { id: 'skill', kind: 'skill', path: '/skills/x' },
    { id: 'noskill', kind: 'skill' },
    { id: 'chat', kind: 'chat', threadId: 'side', readOnly: true },
    { id: 'nochat', kind: 'chat' },
    { id: 'term', kind: 'terminal', cwd: '/t', title: 'zsh', command: ['ssh'], input: 'ls' },
    // a harness's sign-in may run with environment it asked for
    { id: 'term2', kind: 'terminal', env: { KIMI_X: '1' } },
  ];
  await renderPane({ paneTabs: tabs, paneActive: 'files' });
  const panels = () => [...host.querySelectorAll<HTMLElement>('[data-panel]')].map((p) => p.getAttribute('data-panel'));
  assert.deepEqual(panels(), ['FilesPanel', 'SkillPanel', 'ThreadView', 'TermView', 'TermView']);
  await act(async () => fixture.update({ paneActive: 'file' }));
  assert.deepEqual(JSON.parse(host.querySelector('[data-panel="FilePreview"]')!.getAttribute('data-props')!), {
    path: '/repo/a.ts',
    line: 3,
    cwd: '/repo',
  });
  await act(async () => fixture.update({ paneActive: 'file-cwd' }));
  assert.equal(JSON.parse(host.querySelector('[data-panel="FilePreview"]')!.getAttribute('data-props')!).cwd, '/other');
  await act(async () => fixture.update({ paneActive: 'term' }));
  assert.deepEqual(
    [...host.querySelectorAll('[data-panel="TermView"]')].map((t) => t.getAttribute('data-visible')),
    ['true', 'false'],
  );
  assert.deepEqual(fixture.term.tab, {
    id: 'term2',
    cwd: '/repo',
    title: '',
    command: undefined,
    input: undefined,
    signIn: undefined,
    env: { KIMI_X: '1' },
  });
  // a terminal that exits closes its tab; "claude auth login" rechecks Claude
  fixture.term.onExit();
  assert.deepEqual(fixture.calls.at(-1), ['closePaneTab', 'term2']);
  await act(async () => fixture.update({ paneTabs: [{ id: 'login', kind: 'terminal', title: 'claude auth login' }], paneActive: 'login' }));
  fixture.term.onExit();
  assert.deepEqual(fixture.calls.at(-1), ['closePaneTab', 'login']);
  assert.deepEqual(calls.at(-1), ['recheckClaude']);
});

test('SidePane: width, resizing, full view with its composer, and the tab strip width', async () => {
  const el = await renderPane({ paneTabs: [{ id: 'changes', kind: 'changes' }], paneActive: 'changes' });
  const pane = el.querySelector<HTMLElement>('.side-pane')!;
  assert.equal(pane.style.width, '600px', 'half the content lane');
  pane.getBoundingClientRect = () => ({ width: 640.4 }) as any; // the tab strip follows the pane's real width
  await act(async () => observers[0].cb());
  assert.equal(fixture.state.paneWidth, 640);
  // dragging the edge resizes within bounds
  const handle = el.querySelector<HTMLElement>('.pane-resize')!;
  await act(async () => handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 1000 })));
  await act(async () => handle.dispatchEvent(pointerEvent('pointermove', { clientX: 900 })));
  await frame();
  assert.equal(pane.style.width, '700px');
  await act(async () => handle.dispatchEvent(pointerEvent('pointermove', { clientX: 2000 })));
  await frame();
  assert.equal(pane.style.width, '400px');
  await act(async () => handle.dispatchEvent(pointerEvent('pointerup')));
  await act(async () => handle.dispatchEvent(pointerEvent('pointermove', { clientX: 0 })));
  await frame();
  assert.equal(pane.style.width, '400px', 'released: no more resizing');
  // full view: no width, and a floating composer for the chat
  await act(async () => fixture.update({ paneFull: true }));
  assert.match(pane.className, /\bfull\b/);
  assert.equal(pane.style.width, '');
  assert.deepEqual(JSON.parse(el.querySelector('[data-panel="Composer"]')!.getAttribute('data-props')!), {
    threadId: 'chat-a',
    variant: 'thread',
  });
  // back from full view: the lane is measured again, at the share the drag left (400 of 1000)
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 1000 });
  await act(async () => fixture.update({ paneFull: false }));
  assert.equal(pane.style.width, '400px');
  // no chat on screen: no composer in full view
  await act(async () => root.render(h(SidePane, { cwd: '/repo', threadId: null })));
  await act(async () => fixture.update({ paneFull: true }));
  assert.equal(el.querySelector('[data-panel="Composer"]'), null);
  // unmounting gives the strip its width back and leaves full view
  await act(async () => root.unmount());
  root = null;
  assert.deepEqual([fixture.state.paneWidth, fixture.state.paneFull], [0, false]);
  assert.ok(observers.every((o) => o.disconnected));
});

test("an artifact tab stays mounted, shown in front, with the browser's claude.ai sign-in (unknown until main reports it)", async () => {
  store.set({
    paneActive: 'a',
    paneTabs: [
      { id: 'a', kind: 'artifact', url: 'https://claude.ai/artifact/Ab3_xY9z' },
      { id: 'c', kind: 'changes' },
    ],
  });
  let r = await render(h(SidePane, { cwd: '/repo', threadId: 't1' }));
  assert.deepEqual(
    [props(r.host, 'artifact').shown, props(r.host, 'artifact').signedIn, props(r.host, 'artifact').tab.id],
    [true, null, 'a'],
  );
  await r.unmount();
  store.set({ paneActive: 'c', claudeSite: { signedIn: true, seq: 2 } });
  r = await render(h(SidePane, { cwd: '/repo', threadId: 't1' }));
  assert.deepEqual([props(r.host, 'artifact').shown, props(r.host, 'artifact').signedIn], [false, true]);
  await r.unmount();
});
