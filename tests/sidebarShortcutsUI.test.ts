// The sidebar's held-modifier hints identify the same visible chats as numbered keyboard navigation.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h, StrictMode, useRef } from 'react';
import {
  reset,
  mountSidebar,
  key,
  thread,
  project,
  fire,
  click,
  byText,
  update,
  getState,
  render,
  Sidebar,
} from './support/shell-sidebar-kit.ts';
const { sidebarShortcutTargets, numberedSidebarChat, useSidebarShortcutHints } = await import('../src/session/sidebarShortcuts.tsx');

const hints = (view: Awaited<ReturnType<typeof mountSidebar>>) => view.$$('.chat-shortcut-hint').map((el) => el.textContent);
const release = () => fire(document.body, new KeyboardEvent('keyup', { key: 'Meta', bubbles: true }));
beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());
const hold = async (...args: Parameters<typeof key>) => {
  await key(...args);
  await act(async () => mock.timers.tick(500));
};
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
const twoChats = () =>
  reset({
    threads: { a: thread('a'), b: thread('b', { updatedAt: 5 }) },
    threadOrder: ['a', 'b'],
    savedProjects: [project('a')],
  });

test('holding Command reveals numbered session shortcuts and releasing it removes them', async (t) => {
  twoChats();
  const view = await mountSidebar();
  t.after(() => view.unmount());
  assert.deepEqual(hints(view), []);
  await hold(document.body, 'Meta', { metaKey: true });
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  assert.equal(view.$('.chat-shortcut-hint').getAttribute('aria-hidden'), 'true');
  assert.equal(view.$('[data-sidebar-chat]').getAttribute('aria-label'), 'Chat a');
  await release();
  assert.deepEqual(hints(view), []);
  await hold(document.body, 'Alt', { metaKey: true, altKey: true });
  assert.deepEqual(hints(view), ['⌥⌘1', '⌥⌘2']);
  await fire(document.body, new KeyboardEvent('keyup', { key: 'Alt', metaKey: true, bubbles: true }));
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  // A number's key-up can be absent on macOS; releasing Command still clears everything.
  await key(document.body, '1', { metaKey: true });
  await release();
  assert.deepEqual(hints(view), []);
});

test('focus loss, visibility, IME and shortcut-owning overlays clear hints and allow recovery', async (t) => {
  twoChats();
  const view = await mountSidebar();
  t.after(() => view.unmount());
  for (const target of ['blur', 'visibilitychange']) {
    await hold(document.body, 'Meta', { metaKey: true });
    await act(async () => (target === 'blur' ? window : document).dispatchEvent(new Event(target)));
    assert.deepEqual(hints(view), []);
  }
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    await hold(document.body, 'Meta', { metaKey: true });
    await key(document.body, 'Process', { metaKey: true, ...composition });
    assert.deepEqual(hints(view), []);
  }
  await hold(document.body, 'Meta', { metaKey: true });
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  document.body.append(overlay);
  await settle();
  assert.deepEqual(hints(view), []);
  overlay.remove();
  await settle();
  await act(async () => mock.timers.tick(500));
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  await key(document.body, 'Shift', { shiftKey: true });
  assert.deepEqual(hints(view), []);
});

test('hints follow effective custom bindings, removals, shadowing and collision resolution', async (t) => {
  twoChats();
  const view = await mountSidebar();
  t.after(() => view.unmount());
  await hold(document.body, 'Meta', { metaKey: true });
  await update({ ...getState(), prefs: { ...getState().prefs, keybindings: { 'chat-1': '⇧⌘8', 'chat-2': null, pin: '⌘1' } } });
  assert.deepEqual(hints(view), []);
  await key(document.body, 'Shift', { shiftKey: true, metaKey: true });
  assert.deepEqual(hints(view), ['⇧⌘8']);
  await update({ ...getState(), prefs: { ...getState().prefs, keybindings: { 'chat-2': '⇧⌘8', 'chat-1': '⇧⌘8' } } });
  assert.deepEqual(hints(view), ['⇧⌘8']);
  await update({ ...getState(), prefs: { ...getState().prefs, keybindings: { pin: '⌘1' } } });
  await hold(document.body, 'Meta', { metaKey: true });
  assert.deepEqual(hints(view), ['⌘2']);
});

test('rendered order owns hints and target selection across pinning, collapse, recents and list mode', async (t) => {
  twoChats();
  await update({ ...getState(), pinned: { b: true }, prefs: { chatSort: 'manual', chatOrder: { '@list': ['b', 'a'] } } });
  const view = await mountSidebar();
  t.after(() => view.unmount());
  await hold(document.body, 'Meta', { metaKey: true });
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  const failFallback = () => {
    throw new Error('must use displayed rows');
  };
  assert.equal(numberedSidebarChat('chat-1', failFallback), 'b');
  assert.equal(numberedSidebarChat('chat-2', failFallback), 'a');
  assert.equal(numberedSidebarChat('chat-3', failFallback), undefined);
  // Local disclosure state changes without rerendering the sidebar owner.
  await click(byText(view.host, '.side-label', 'Projects'));
  await settle();
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  assert.equal(numberedSidebarChat('chat-2', failFallback), 'a');
  await click(byText(view.host, '.side-label', 'Recents'));
  await settle();
  assert.deepEqual(hints(view), ['⌘1']);
  assert.equal(numberedSidebarChat('recent-1', failFallback), undefined);
  await click(byText(view.host, '.side-label', 'Projects'));
  await update({ ...getState(), pinned: {}, prefs: { ...getState().prefs, sidebarOrganize: 'list' } });
  await settle();
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  assert.equal(numberedSidebarChat('chat-1', failFallback), 'b');
  await update({ ...getState(), threadOrder: ['a'], threads: { a: getState().threads.a } });
  await settle();
  assert.deepEqual(hints(view), ['⌘1']);
  assert.equal(numberedSidebarChat('chat-1', failFallback), 'a');
  view.$('aside').classList.add('leaving');
  await settle();
  assert.deepEqual(hints(view), []);
});

test('the shared collector includes nested mixed-harness ids, deduplicates rows and respects numeric limits', () => {
  const sidebar = document.createElement('aside');
  sidebar.className = 'thread-sidebar';
  document.body.append(sidebar);
  const add = (id: string, parent = sidebar) => {
    const row = document.createElement('div');
    row.dataset.sidebarChat = id;
    parent.append(row);
    return row;
  };
  try {
    assert.deepEqual(sidebarShortcutTargets(sidebar), []);
    const ids = ['opaque"id\\:1', 'claude:2', 'acp:3', ...Array.from({ length: 9 }, (_, i) => String(i))];
    const hidden = document.createElement('div');
    hidden.className = 'collapse';
    sidebar.append(hidden);
    add('closed', hidden);
    add('', sidebar);
    const inert = document.createElement('div');
    inert.setAttribute('inert', '');
    sidebar.append(inert);
    add('inert', inert);
    for (const id of ids) add(id);
    const recent = document.createElement('div');
    recent.dataset.shortcutRecents = '';
    sidebar.append(recent);
    for (const id of [...ids, ids[0]]) add(id, recent);
    const targets = sidebarShortcutTargets(sidebar);
    assert.deepEqual(
      targets.filter((t) => t.action.startsWith('chat-')).map((t) => t.id),
      ids.slice(0, 9),
    );
    assert.deepEqual(
      targets.filter((t) => t.action.startsWith('recent-')).map((t) => t.id),
      ids.slice(0, 6),
    );
    assert.equal(
      numberedSidebarChat('chat-9', () => []),
      ids[8],
    );
    assert.equal(
      numberedSidebarChat('recent-6', () => []),
      ids[5],
    );
    hidden.classList.add('open');
    assert.equal(
      numberedSidebarChat('chat-1', () => []),
      'closed',
    );
    sidebar.classList.add('leaving');
    assert.equal(
      numberedSidebarChat('chat-1', () => ['fallback']),
      'fallback',
    );
    sidebar.className = 'thread-sidebar drag-hidden';
    assert.equal(
      numberedSidebarChat('chat-2', () => ['fallback']),
      undefined,
    );
  } finally {
    sidebar.remove();
  }
});

test('activity rows and empty lists use the same hints, and Strict Mode disposes observers and listeners', async (t) => {
  twoChats();
  await update({ ...getState(), activityView: true, unread: { b: true, a: true } });
  const view = await render(h(StrictMode, null, h(Sidebar.Sidebar, { width: 280 })));
  await hold(document.body, 'Meta', { metaKey: true });
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  assert.equal(
    numberedSidebarChat('chat-1', () => []),
    'b',
  );
  await view.unmount();
  await hold(document.body, 'Meta', { metaKey: true });
  reset();
  const empty = await mountSidebar();
  t.after(() => empty.unmount());
  assert.deepEqual(hints(empty), []);
  await hold(document.body, 'Meta', { metaKey: true });
  assert.deepEqual(hints(empty), []);
  assert.equal(
    numberedSidebarChat('chat-1', () => ['wrong']),
    undefined,
  );
});

test('a sidebar owner without a mounted element installs no listeners', async (t) => {
  const added = mock.method(window, 'addEventListener');
  t.after(() => added.mock.restore());
  let hints: Map<Element, string> | null = null;
  function NoElement() {
    hints = useSidebarShortcutHints(useRef<HTMLElement>(null));
    return null;
  }
  const view = await render(h(NoElement));
  await hold(document.body, 'Meta', { metaKey: true });
  const watched = ['keydown', 'keyup', 'blur', 'browser-shortcut-modifiers'];
  assert.deepEqual(
    added.mock.calls.map((c: any) => c.arguments[0]).filter((name: string) => watched.includes(name)),
    [],
  );
  assert.equal(hints!.size, 0, 'a held modifier shows no hints');
  await view.unmount();
});

test('a queued observer callback cannot read a retired sidebar or affect a replacement owner', async (t) => {
  const callbacks: MutationCallback[] = [];
  const RealObserver = globalThis.MutationObserver;
  mock.method(
    globalThis,
    'MutationObserver',
    class extends RealObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        callbacks.push(callback);
      }
    },
  );
  t.after(() => mock.restoreAll());
  twoChats();
  const old = await mountSidebar();
  await hold(document.body, 'Meta', { metaKey: true });
  const oldRoot = old.$('aside');
  await old.unmount();
  mock.method(oldRoot, 'querySelectorAll', () => {
    throw new Error('read a retired owner');
  });
  const replacement = await render(h(Sidebar.Sidebar, { width: 280, leaving: true }));
  t.after(() => replacement.unmount());
  await act(async () => callbacks[0]([], {} as MutationObserver));
  await hold(document.body, 'Meta', { metaKey: true });
  assert.deepEqual(hints(replacement), []);
});

test('hints respect focused terminal, browser and native text editing ownership, including focus changes while held', async (t) => {
  twoChats();
  const view = await mountSidebar();
  t.after(() => view.unmount());
  const host = document.createElement('div');
  const input = document.createElement('input');
  host.append(input);
  document.body.append(host);
  t.after(() => host.remove());
  for (const [scope, binding] of [
    ['term-view', '⌘K'],
    ['browser-pane', '⌘R'],
    ['', '⌘A'],
    ['', '⇧8'],
  ]) {
    host.className = scope;
    await update({ ...getState(), prefs: { ...getState().prefs, keybindings: { 'chat-1': binding, 'chat-2': null } } });
    await act(async () => input.focus());
    await hold(input, 'Meta', { metaKey: binding.includes('⌘'), shiftKey: binding.includes('⇧') });
    assert.deepEqual(hints(view), [], `${scope} retains ${binding}`);
  }
  await update({ ...getState(), prefs: { ...getState().prefs, keybindings: { 'chat-1': '⌘A', 'chat-2': null } } });
  await hold(input, 'Meta', { metaKey: true });
  await act(async () => input.blur());
  assert.deepEqual(hints(view), ['⌘A']);
});

test('native browser modifiers have a current pane owner and clear across pane switches', async (t) => {
  twoChats();
  await update({ ...getState(), paneActive: 'browser', diffPanel: { open: true } });
  const view = await mountSidebar();
  t.after(() => view.unmount());
  const deliver = (combo: string, paneId = 'browser') =>
    act(async () => {
      window.dispatchEvent(new CustomEvent('browser-shortcut-modifiers', { detail: { combo, paneId } }));
      mock.timers.tick(500);
    });
  await deliver('⌘', 'other');
  assert.deepEqual(hints(view), []);
  await deliver('⌘');
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  await update({ ...getState(), prefs: { ...getState().prefs, keybindings: { 'chat-1': '⌘R', 'chat-2': '⌘A' } } });
  assert.deepEqual(hints(view), [], 'browser-owned reload and native editing are not session hints');
  await update({ ...getState(), prefs: { ...getState().prefs, keybindings: { 'chat-1': '⇧8' } } });
  await deliver('⇧');
  assert.deepEqual(hints(view), [], 'native pages cannot deliver an ordinary character as an app shortcut');
  await update({ ...getState(), prefs: { ...getState().prefs, keybindings: {} } });
  await deliver('⌘');
  await update({ ...getState(), paneActive: 'other', diffPanel: { open: false } });
  await deliver('');
  assert.deepEqual(hints(view), [], 'the old owner can release after selection moves');
  await deliver('⌘', 'other');
  assert.deepEqual(hints(view), [], 'a closed pane cannot publish modifiers');
});

test('a delayed native page release cannot clear modifiers acquired by the renderer after focus returns', async (t) => {
  twoChats();
  await update({ ...getState(), paneActive: 'browser', diffPanel: { open: true } });
  const view = await mountSidebar();
  t.after(() => view.unmount());
  const native = (combo: string) =>
    act(async () => {
      window.dispatchEvent(new CustomEvent('browser-shortcut-modifiers', { detail: { combo, paneId: 'browser' } }));
      mock.timers.tick(500);
    });
  await native('⌘');
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  await hold(document.body, 'Meta', { metaKey: true });
  await native('');
  assert.deepEqual(hints(view), ['⌘1', '⌘2']);
  await release();
  assert.deepEqual(hints(view), []);
});
