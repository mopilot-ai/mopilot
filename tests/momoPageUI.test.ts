// MoMo's page with its live views (src/components/momo/MomoPage.tsx, MomoChatTab.tsx): Chat's main chat (or another MoMo
// chat) under MoMo's floating identity, with the brain chip in its composer's model picker slot, loaded by the view itself; Memory under its own title; a notice's chat routed to the Chat tab (src/lib/momoRoute.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createContext, createElement as h, act, useContext } from 'react';
import { render, click, flush } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';

const calls: any[] = [];
let mainChat: () => Promise<any> = async () => ({ chatId: 'm1', warning: null });
let openThread: (id: string) => Promise<void> = async () => {};
let done = true;
let rowState: string | null = null;
let paused = false;
let tasksPanel = false;
let momoChats: Record<string, string> = {};
let savePref: (k: string, v: unknown) => Promise<boolean> = async () => true;
let brainChanged: (() => void) | null = null;

mockSource('src/session/useChatRowState.ts', { useChatRowState: () => (rowState ? { state: rowState } : null) });
stubStore({
  useStore: (sel: any) => sel({ route: { name: 'momo' }, momoChats }),
  navigate: (r: any) => calls.push(['navigate', r]),
  openThread: (id: string) => (calls.push(['openThread', id]), openThread(id)),
  setDraft: (id: string, d: any) => calls.push(['draft', id, d]),
  toast: (t: string) => calls.push(['toast', t]),
});
installNativeStub({
  momoChat: { mainChat: () => mainChat(), onBrainChanged: (cb: () => void) => ((brainChanged = cb), () => (brainChanged = null)) },
});
mockSource('src/session/momoPrefs.ts', {
  useMomoPrefs: () => ({ onboarding: { done }, paused, tasksPanel, persona: { name: 'MoMo', color: 'clay' } }),
  saveMomoPref: (k: string, v: unknown) => (calls.push(['pref', k, v]), savePref(k, v)),
});
mockSource('src/components/momo/setup/MomoSetup.tsx', { MomoSetup: () => h('div', { 'data-stub': 'setup' }) });
// the composer's model picker slot in a MoMo chat, as the composer draws it (tests/momoComposerChrome.test.ts)
const MomoModelSlot = createContext<any>(null);
mockSource('src/components/momo/useMomoChat.ts', { MomoModelSlot, MomoPlaceholder: createContext('Message MoMo') });
const Picker = () => useContext(MomoModelSlot) ?? h('span', { 'data-stub': 'model' });
mockSource('src/components/thread/ThreadView.tsx', {
  ThreadView: ({ threadId, inPane, readOnly, readOnlyNote }: any) =>
    h('div', { 'data-thread': threadId, 'data-pane': String(inPane), 'data-read-only': String(!!readOnly) }, readOnlyNote ?? h(Picker)),
});
mockSource('src/components/momo/BrainChip.tsx', { BrainChip: () => h('span', { 'data-stub': 'chip' }) });
mockSource('src/components/momo/MomoPanel.tsx', {
  MomoPanel: ({ chatId }: any) => h('aside', { 'data-stub': 'panel', 'data-chat': String(chatId) }),
});
mockSource('src/components/momo/MemoryTab.tsx', { MemoryTab: () => h('div', { 'data-stub': 'memory' }) });
mockSource('src/components/momo/TasksTab.tsx', { TasksTab: () => h('div', { 'data-stub': 'tasks' }) });
mockSource('src/components/momo/tasks/TasksPanel.tsx', { TasksPanel: () => h('div', { 'data-stub': 'tasks-panel' }) });
let homeStatus = 'loading';
mockSource('src/components/momo/home/useMomoHome.ts', { useMomoHomeStatus: () => ({ status: homeStatus }) });
mockSource('src/components/momo/home/MomoHomePage.tsx', {
  MomoHomePage: ({ tab }: any) => h('div', { 'data-stub': 'home', 'data-tab': String(tab) }),
});
const { default: MomoPage } = await import('../src/components/momo/MomoPage.tsx');
const { momoRouteOf } = await import('../src/lib/momoRoute.ts');

const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};
const page = (p: any = {}) => render(h(MomoPage, p));

test('setup until it is done; then the view the route names, with no tabs: Chat alone, Memory under its title', async () => {
  done = false;
  let r = await page();
  assert.ok(r.host.querySelector('[data-stub=setup]'));
  await r.unmount();
  done = true;
  for (const [tab, title] of [
    ['memory', 'Memory'],
    ['tasks', 'Tasks'],
  ]) {
    r = await page({ tab });
    assert.equal(r.host.querySelector('[role=tab]'), null);
    assert.equal(r.host.querySelector('h1')!.textContent, title);
    assert.ok(r.host.querySelector(`[data-stub=${tab}]`));
    await r.unmount();
  }
  r = await page();
  assert.equal(r.host.querySelector('h1'), null, 'Chat has no page title');
  assert.equal(r.host.querySelector('section')!.getAttribute('aria-label'), 'Chat');
  assert.equal(
    r.host.firstElementChild!.firstElementChild!.tagName,
    'SECTION',
    'Chat is the page itself, never inside a page that scrolls (#2277)',
  );
  assert.equal(r.host.querySelector('[data-stub=panel]'), null, 'no panel where the window has no room');
  assert.equal(r.host.querySelector('[aria-label="Hide details"]'), null);
  await r.unmount();
});

test('Chat: MoMo’s main chat under its identity, the brain chip in the composer, its history loaded, a warning said', async () => {
  const d = deferred<any>();
  mainChat = () => d.promise;
  calls.length = 0;
  const r = await page();
  assert.equal(r.host.querySelector('.empty')!.textContent, 'MoMo is getting ready.');
  assert.equal(r.host.querySelector('header .name')!.textContent, 'MoMo');
  assert.equal(r.host.querySelector('[data-stub=chip]'), null, 'no chip until the chat is there');
  await act(async () => d.resolve({ chatId: 'm1', warning: 'Couldn’t put MoMo on that account.' }));
  await settle();
  const thread = r.host.querySelector('[data-thread]')!;
  assert.equal(thread.getAttribute('data-thread'), 'm1');
  assert.equal(thread.getAttribute('data-pane'), 'true');
  assert.ok(thread.querySelector('[data-stub=chip]'), 'the brain chip sits in the composer’s model picker slot');
  assert.equal(thread.querySelector('[data-stub=model]'), null);
  assert.deepEqual(calls, [['openThread', 'm1']]);
  assert.equal(r.host.querySelector('header .note')!.textContent, 'Couldn’t put MoMo on that account.');
  assert.equal(r.host.querySelector('[aria-label="Back to MoMo"]'), null);
  assert.equal(r.host.querySelector('[role=status]')!.textContent, 'Active', 'idle: on and ready');
  // a brain change that made a new main chat: the tab follows it; an older read settling later changes nothing
  const slow = deferred<any>();
  mainChat = () => slow.promise;
  await act(async () => brainChanged!());
  mainChat = async () => ({ chatId: 'm2', warning: null });
  await act(async () => brainChanged!());
  await settle();
  await act(async () => slow.resolve({ chatId: 'm1', warning: null }));
  await settle();
  assert.equal(r.host.querySelector('[data-thread]')!.getAttribute('data-thread'), 'm2');
  assert.equal(r.host.querySelector('.note'), null);
  const stale = deferred<any>();
  mainChat = () => stale.promise;
  await act(async () => brainChanged!());
  mainChat = async () => ({ chatId: 'm2', warning: null });
  await act(async () => brainChanged!());
  await settle();
  await act(async () => stale.reject(new Error('old')));
  await settle();
  assert.equal(r.host.querySelector('[role=alert]'), null, 'an older failure says nothing');
  await r.unmount();
  assert.equal(brainChanged, null, 'closing the tab stops listening');
});

test('Chat’s identity says what MoMo is doing in the shown chat, on any harness: needs you, working, or Active when idle', async () => {
  // no chat yet: no status, whatever the store holds
  const pending = deferred<any>();
  mainChat = () => pending.promise;
  rowState = 'working';
  const waiting = await page();
  assert.equal(waiting.host.querySelector('header [role=status]'), null);
  await waiting.unmount();
  mainChat = async () => ({ chatId: 'm1', warning: null });
  for (const [state, text, tone] of [
    ['approval', 'Needs you', 'needs'],
    ['input', 'Needs you', 'needs'],
    ['working', 'Working…', 'busy'],
    ['elsewhereRunning', 'Working…', 'busy'],
    ['unread', 'Active', 'active'],
  ]) {
    rowState = state;
    const r = await page();
    await settle();
    const status = r.host.querySelector('header [role=status]');
    assert.equal(status?.textContent ?? null, text, state!);
    assert.equal(status?.getAttribute('data-tone') ?? null, tone, state!);
    await r.unmount();
  }
  rowState = null;
});

test('while MoMo is paused the identity says so, with Resume, which saves the setting once at a time', async () => {
  mainChat = async () => ({ chatId: 'm1', warning: null });
  paused = true;
  rowState = 'working';
  const r = await page();
  await settle();
  const status = r.host.querySelector('header [role=status]')!;
  assert.equal(status.getAttribute('data-tone'), 'paused');
  assert.equal(status.textContent, 'Paused · Resume', 'paused comes before what the chat is doing');
  const saved = deferred<boolean>();
  savePref = () => saved.promise;
  calls.length = 0;
  const resume = status.querySelector('button')!;
  await click(resume);
  assert.deepEqual(calls, [['pref', 'paused', false]]);
  assert.equal(resume.disabled, true, 'one save at a time');
  await act(async () => saved.resolve(true));
  await settle();
  assert.equal(resume.disabled, false);
  await r.unmount();
  paused = false;
  rowState = null;
  savePref = async () => true;
});

test('an earlier main chat (a brain change replaced it) shows read-only, with the way back to MoMo’s main chat', async () => {
  mainChat = async () => ({ chatId: 'm1', warning: null });
  momoChats = { old: 'previous', m1: 'main' };
  const r = await page({ tab: 'chat', chatId: 'old' });
  await settle();
  const thread = r.host.querySelector('[data-thread]')!;
  assert.equal(thread.getAttribute('data-read-only'), 'true');
  assert.equal(thread.textContent, 'An earlier conversation · Read only');
  assert.ok(r.host.querySelector('header [aria-label="Back to MoMo"]'));
  await r.unmount();
  const main = await page();
  await settle();
  assert.equal(main.host.querySelector('[data-thread]')!.getAttribute('data-read-only'), 'false');
  await main.unmount();
  momoChats = {};
});

test('another MoMo chat on the Chat tab, with the way back; failures are said', async () => {
  mainChat = async () => ({ chatId: 'm1', warning: null });
  openThread = async () => {
    throw new Error('That chat is gone.');
  };
  calls.length = 0;
  const r = await page({ tab: 'chat', chatId: 'run-1' });
  await settle();
  assert.equal(r.host.querySelector('[data-thread]')!.getAttribute('data-thread'), 'run-1');
  assert.equal(r.host.querySelector('[role=alert]')!.textContent, 'That chat is gone.');
  await click(r.host.querySelector('header [aria-label="Back to MoMo"]'));
  assert.deepEqual(calls.at(-1), ['navigate', { name: 'momo', tab: 'chat' }]);
  await r.unmount();
  openThread = async () => {};
  mainChat = async () => {
    throw new Error('MoMo is not available for this account.');
  };
  const failed = await page();
  await settle();
  assert.equal(failed.host.querySelector('[role=alert]')!.textContent, 'MoMo is not available for this account.');
  assert.equal(failed.host.querySelector('.empty'), null, 'no “getting ready” under a failure');
  await failed.unmount();
});

test('a main chat read that settles after the tab closed changes nothing', async () => {
  const ok = deferred<any>();
  mainChat = () => ok.promise;
  let r = await page();
  await r.unmount();
  await act(async () => ok.resolve({ chatId: 'm1', warning: null }));
  const bad = deferred<any>();
  mainChat = () => bad.promise;
  r = await page();
  await r.unmount();
  await act(async () => bad.reject(new Error('late')));
  await settle();
});

test('a MoMo notice opens the page at its chat; anything else opens the page', () => {
  assert.deepEqual(momoRouteOf({ kind: 'chat', chatId: 'mc' }), { name: 'momo', tab: 'chat', chatId: 'mc' });
  assert.deepEqual(momoRouteOf({ kind: 'chat', chatId: '' }), { name: 'momo' });
  assert.deepEqual(momoRouteOf({ kind: 'feed', itemId: 'f' }), { name: 'momo' }, 'the Feed is gone: an old target opens the page');
  assert.deepEqual(momoRouteOf({ kind: 'topic', topicId: 't' }), { name: 'momo' });
  assert.deepEqual(momoRouteOf(undefined), { name: 'momo' });
  assert.deepEqual(momoRouteOf('momo'), { name: 'momo' });
});

test('the right panel: shown when the window has room and the viewer wants it, taking the identity from the header; the toggle is remembered', async () => {
  let width = 0;
  let fire: ((w: number) => void) | null = null;
  let stopped = 0;
  (window as any).ResizeObserver = class {
    constructor(cb: any) {
      fire = (w: number) => cb([{ contentRect: { width: w } }]);
    }
    observe() {}
    disconnect() {
      stopped++;
      fire = null;
    }
  };
  (globalThis as any).ResizeObserver = (window as any).ResizeObserver;
  localStorage.removeItem('momo.panelOpen');
  mainChat = async () => ({ chatId: 'm1', warning: null });
  const resize = async (w: number) => act(async () => ((width = w), fire!(w)));
  let r = await page();
  await settle();
  assert.ok(r.host.querySelector('header .name'), 'narrow: the identity is in the header');
  await resize(1100);
  assert.equal(r.host.querySelector('[data-stub=panel]'), null);
  assert.equal(r.host.querySelector('[aria-label="Hide details"]'), null, 'no toggle without room for the panel');
  await resize(1300);
  assert.equal(r.host.querySelector('[data-stub=panel]')!.getAttribute('data-chat'), 'm1');
  assert.equal(r.host.querySelector('header .name'), null, 'the identity moved into the panel');
  const toggle = r.host.querySelector('[aria-label="Hide details"]')!;
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  await click(toggle);
  assert.equal(r.host.querySelector('[data-stub=panel]'), null);
  assert.ok(r.host.querySelector('header .name'), 'hidden: the identity is back in the header');
  assert.equal(localStorage.getItem('momo.panelOpen'), 'off');
  assert.equal(r.host.querySelector('[aria-label="Show details"]')!.getAttribute('aria-pressed'), 'false');
  // remembered by the next view
  await r.unmount();
  assert.equal(stopped, 1, 'closing the page stops following its width');
  r = await page();
  await settle();
  await resize(1300);
  assert.equal(r.host.querySelector('[data-stub=panel]'), null, 'still hidden');
  await click(r.host.querySelector('[aria-label="Show details"]'));
  assert.ok(r.host.querySelector('[data-stub=panel]'));
  assert.equal(localStorage.getItem('momo.panelOpen'), 'on');
  await r.unmount();
  // a browser store that is missing or throws: the panel is on, and the choice only holds for the window
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
  });
  r = await page();
  await settle();
  await resize(1300);
  assert.ok(r.host.querySelector('[data-stub=panel]'));
  await click(r.host.querySelector('[aria-label="Hide details"]'));
  assert.equal(r.host.querySelector('[data-stub=panel]'), null);
  await r.unmount();
  Object.defineProperty(globalThis, 'localStorage', real);
  delete (window as any).ResizeObserver;
  delete (globalThis as any).ResizeObserver;
  assert.equal(width, 1300);
});

test('without a ResizeObserver the page has no room for the panel and says nothing', async () => {
  const had = (globalThis as any).ResizeObserver;
  delete (globalThis as any).ResizeObserver;
  const r = await page();
  await settle();
  assert.equal(r.host.querySelector('[data-stub=panel]'), null);
  await r.unmount();
  if (had) (globalThis as any).ResizeObserver = had;
});

test('Tasks is the classic tab until the `momo.tasksPanel` flag is on, then the four-tab panel under the same title', async () => {
  done = true;
  let r = await page({ tab: 'tasks' });
  assert.ok(r.host.querySelector('[data-stub=tasks]'));
  assert.equal(r.host.querySelector('[data-stub=tasks-panel]'), null);
  await r.unmount();
  tasksPanel = true;
  try {
    r = await page({ tab: 'tasks' });
    assert.equal(r.host.querySelector('h1')!.textContent, 'Tasks');
    assert.ok(r.host.querySelector('[data-stub=tasks-panel]'));
    assert.equal(r.host.querySelector('[data-stub=tasks]'), null);
    await r.unmount();
  } finally {
    tasksPanel = false;
  }
});

test('once MoMo’s home has answered, its surfaces are the page, on the tab the route names; until then the pages above are', async () => {
  done = true;
  homeStatus = 'ready';
  const r = await page({ tab: 'tasks' });
  assert.equal(r.host.querySelector('[data-stub=home]')!.getAttribute('data-tab'), 'tasks');
  assert.equal(r.host.querySelector('[data-stub=tasks]'), null);
  await r.unmount();
  homeStatus = 'loading';
  const before = await page({ tab: 'tasks' });
  assert.equal(before.host.querySelector('[data-stub=home]'), null);
  assert.ok(before.host.querySelector('[data-stub=tasks]'));
  await before.unmount();
});
