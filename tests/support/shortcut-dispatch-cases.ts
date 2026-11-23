// Focused shortcut action, workspace and async-owner cases registered against the real App fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerShortcutAsyncCases } from './shortcut-async-cases';
import { registerSettingsExitCases } from './shortcut-settings-cases';
import { registerNewChatLinkCases } from './shortcut-link-cases';
import { registerFileFindCases } from './shortcut-file-find-cases';
import { SHORTCUT_ACTIONS } from '../../shared/shortcuts.mjs';
import { act } from 'react';
import { native } from '../../src/lib/native.ts';
import { window as domWindow } from './dom.ts';
const window = domWindow as unknown as Window & typeof globalThis;
/** The bridge's flags while a case runs (the App fixture's bridge has none); returns what puts them back. */
function withFlags(isEnabled: (key: string) => boolean) {
  const bridge = native as any;
  const was = bridge.flags;
  bridge.flags = { isEnabled, onChanged: () => () => {} };
  return () => {
    bridge.flags = was;
  };
}
export function registerShortcutDispatchCases(fx: any) {
  registerShortcutAsyncCases(fx);
  registerSettingsExitCases(fx);
  registerNewChatLinkCases(fx);
  registerFileFindCases(fx);
  const { reset, mount, cmd, set, key, calls, writes, unmount, getState, setGroups } = fx;
  test('docked as the computer-use panel: the chat alone (no sidebar, side panes or terminal) until main undocks it', async () => {
    reset({ route: { name: 'thread', id: 'a' }, diffPanel: { open: true }, bottomPanelOpen: true, sidebarOpen: true });
    await mount();
    const parts = () => [...document.querySelectorAll('[data-c]')].map((e) => (e as HTMLElement).dataset.c);
    assert.ok(parts().includes('SidePane') && parts().includes('TerminalPanel'));
    await cmd('docked', true);
    await act(() => new Promise((r) => setTimeout(r, 260))); // the sidebar's leaving transition
    assert.equal(document.documentElement.classList.contains('docked'), true);
    assert.deepEqual(
      parts().filter((c) => ['Sidebar', 'SidebarResize', 'SidePane', 'TerminalPanel', 'SummaryPanel'].includes(c!)),
      [],
    );
    assert.ok(parts().includes('ThreadView'), 'the chat stays');
    await cmd('docked', true); // again: nothing changes
    await cmd('docked', false);
    assert.equal(document.documentElement.classList.contains('docked'), false);
    assert.ok(parts().includes('SidePane') && parts().includes('TerminalPanel'));
    await cmd('docked', 'yes'); // only true docks
    assert.equal(document.documentElement.classList.contains('docked'), false);
    await unmount();
  });
  test('Help → Report a Bug… opens the bug report about the chat in view, or none', async () => {
    reset({ route: { name: 'home' } });
    await mount();
    const reports: unknown[] = [];
    const onReport = (e: Event) => reports.push((e as CustomEvent).detail);
    window.addEventListener('open-bug-report', onReport);
    await cmd('report-bug');
    await set({ route: { name: 'thread', id: 'a' } });
    await cmd('report-bug');
    window.removeEventListener('open-bug-report', onReport);
    assert.deepEqual(reports, [{ threadId: null }, { threadId: 'a' }]);
    await unmount();
  });
  test('⌘F asks the chat in view to open its find bar; the browser pane finds in its page, a terminal keeps the key', async () => {
    reset({ route: { name: 'thread', id: 'a' } });
    await mount();
    const asked: unknown[] = [];
    const onFind = (e: Event) => asked.push((e as CustomEvent).detail);
    window.addEventListener('find-in-chat', onFind);
    const press = (target: EventTarget) =>
      act(async () => {
        const e = new window.KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true, bubbles: true, cancelable: true });
        target.dispatchEvent(e);
        return e.defaultPrevented;
      });
    assert.equal(await press(window), true);
    const found: unknown[] = [];
    const onPaneFind = (e: Event) => found.push((e as CustomEvent).detail.id);
    window.addEventListener('workspace-shortcut', onPaneFind);
    for (const owner of ['browser-pane', 'term-view']) {
      const pane = document.createElement('div');
      pane.className = owner;
      const field = document.createElement('input');
      pane.append(field);
      document.body.append(pane);
      assert.equal(await press(field), owner === 'browser-pane', `${owner}: ⌘F is the pane's find, or the shell's`);
      pane.remove();
    }
    window.removeEventListener('workspace-shortcut', onPaneFind);
    assert.deepEqual(found, ['browser-find']);
    // Edit → Find in Chat asks too; with no chat in view there is nothing to find in
    await cmd('shortcut', 'find-in-chat');
    await set({ route: { name: 'home' } });
    await cmd('shortcut', 'find-in-chat');
    window.removeEventListener('find-in-chat', onFind);
    assert.deepEqual(asked, [{ threadId: 'a' }, { threadId: 'a' }]);
    await unmount();
  });
  test('native shortcuts run once, including custom bindings', async () => {
    reset({ route: { name: 'thread', id: 'a' } });
    await mount();
    assert.equal(await key({ key: 'p', code: 'KeyP', metaKey: true, altKey: true }), false);
    await cmd('shortcut', { id: 'pin', combo: '⌥⌘P' });
    assert.equal(getState().pinned.a, true);
    await cmd('shortcut', 'pin');
    assert.equal(getState().pinned.a, false);
    for (const id of ['archive', 'side-chat', 'mark-unread', 'move-to-background']) await cmd('shortcut', id);
    assert.equal(getState().unread.a, true);
    await set({ prefs: { ...getState().prefs, keybindings: { 'new-chat': '⇧⌘Y', 'new-window': '⌘Dead' } } });
    assert.equal(await key({ key: 'Y', code: 'KeyY', metaKey: true, shiftKey: true }), false);
    await cmd('shortcut', { id: 'new-chat', combo: '⇧⌘Y' });
    assert.equal(getState().route.name, 'home');
    await set({ route: { name: 'thread', id: 'a' } });
    assert.equal(await key({ key: 'Dead', code: '', metaKey: true }), true);
    assert.ok(calls.some((c) => c[0] === 'winOpen' && c[1] === 'thread=a'));
    const code = document.createElement('div');
    code.className = 'thread-view';
    code.dataset.threadId = 'a';
    code.innerHTML = '<pre><code>last</code></pre>';
    document.body.append(code);
    await cmd('shortcut', 'copy-code');
    assert.equal(writes.at(-1), 'last');
    // a long thread shows far turns as placeholders: their code comes from the chat's turns
    code.innerHTML = '<div data-turn-slot="t1" style="height: 300px"></div><div data-turn-slot="t2"><p>no code</p></div>';
    await set({ runtime: { a: { turns: [{ id: 't1', items: [{ type: 'agentMessage', text: '```\nfrom history\n```' }] }] } } });
    await cmd('shortcut', 'copy-code');
    assert.equal(writes.at(-1), 'from history');
    // a chat with no turns loaded has nothing to read there
    await set({ runtime: {} });
    const copies = writes.length;
    await cmd('shortcut', 'copy-code');
    assert.equal(writes.length, copies);
    code.remove();
    await cmd('shortcut', 'copy-code');
    await cmd('shortcut', 'chat-2');
    assert.equal(getState().route.id, 'b');
    await cmd('shortcut', 'recent-1');
    assert.equal(getState().route.id, 'c');
    await cmd('shortcut', 'chat-9');
    // zoom steps the whole window (shared/zoom.mjs); the chat font size stays as Settings set it
    await cmd('shortcut', 'font-increase');
    await cmd('shortcut', 'font-increase');
    assert.equal(getState().prefs.zoomLevel, 1);
    await cmd('shortcut', 'font-decrease');
    assert.equal(getState().prefs.zoomLevel, 0.5);
    await cmd('shortcut', 'font-reset');
    assert.equal(getState().prefs.zoomLevel, 0);
    assert.equal(getState().prefs.fontSize, 14);
    const overlay = document.createElement('div');
    overlay.className = 'popover-layer';
    document.body.append(overlay);
    await cmd('shortcut', 'pin');
    assert.equal(getState().pinned.c, undefined);
    overlay.remove();
    for (const init of [
      { key: 'Escape', code: 'Escape' },
      { key: 'Meta', code: 'MetaLeft' },
      { key: 'n', code: 'KeyN', isComposing: true, metaKey: true },
    ])
      await key(init);
    await cmd('shortcut', null);
    await cmd('shortcut', {});
    await cmd('shortcut', 'missing');
    await unmount();
  });

  test('workspace ownership, layout cycling and browser commands leave other chats and modal controls alone', async () => {
    reset({
      route: { name: 'thread', id: 'a' },
      paneTabs: [
        { id: 'one', kind: 'browser', ownerChat: 'a' },
        { id: 'two', kind: 'terminal', ownerChat: 'a' },
        { id: 'hidden', kind: 'browser', ownerChat: 'b' },
      ],
      paneActive: 'one',
      diffPanel: { open: true },
    });
    await mount();
    const pane = document.createElement('div');
    pane.className = 'side-pane';
    pane.innerHTML = '<input />';
    document.body.append(pane);
    pane.querySelector('input')!.focus();
    await cmd('shortcut', 'next-chat');
    assert.equal(getState().paneActive, 'two');
    await cmd('shortcut', 'prev-chat');
    assert.equal(getState().paneActive, 'one');
    await cmd('shortcut', 'close-other-tabs');
    assert.deepEqual(
      calls.filter((c) => c[0] === 'closePaneTab'),
      [['closePaneTab', 'two']],
    );
    await cmd('shortcut', 'close-tab');
    assert.deepEqual(calls.filter((c) => c[0] === 'closePaneTab').at(-1), ['closePaneTab', 'one']);
    await cmd('shortcut', 'full-view');
    assert.equal(getState().paneFull, true);
    await cmd('shortcut', 'toggle-workspace');
    assert.equal(getState().diffPanel.open, false);
    assert.equal(getState().paneFull, true);
    await cmd('shortcut', 'toggle-workspace');
    assert.equal(getState().diffPanel.open, true);
    await cmd('shortcut', 'cycle-layout');
    assert.equal(getState().diffPanel.open, false);
    await cmd('shortcut', 'cycle-layout');
    assert.equal(getState().diffPanel.open, true);
    assert.equal(getState().paneFull, false);
    await cmd('shortcut', 'cycle-layout');
    assert.equal(getState().paneFull, true);
    await cmd('shortcut', 'full-view');
    assert.equal(getState().paneFull, false);
    const events: any[] = [];
    const receive = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener('workspace-shortcut', receive);
    const browser = (combo: string, paneId = getState().paneActive) =>
      window.dispatchEvent(new CustomEvent('browser-shortcut', { detail: { combo, paneId } }));
    await act(async () => {
      for (const combo of ['⌘R', '⌘F', '⌘G', '⇧⌘G']) browser(combo);
      browser('⌘L', 'hidden');
    });
    const ids = ['browser-reload', 'browser-find', 'browser-find-next', 'browser-find-previous'];
    assert.deepEqual(
      events,
      ids.map((id) => ({ id, paneId: 'one' })),
    );
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    document.body.append(modal);
    await act(async () => {
      browser('⌘W');
    });
    assert.equal(calls.filter((c) => c[0] === 'closePaneTab').length, 2);
    modal.remove();
    await act(async () => {
      browser('⌘W');
    });
    assert.equal(calls.filter((c) => c[0] === 'closePaneTab').length, 3);
    await act(async () => {
      browser('unbound');
      window.dispatchEvent(new CustomEvent('browser-shortcut'));
    });
    await set({ diffPanel: { open: false } });
    await act(async () => {
      browser('⌘R');
    });
    assert.equal(events.length, ids.length);
    window.removeEventListener('workspace-shortcut', receive);
    pane.remove();
    await unmount();
  });

  test('all catalog actions have production handlers, and chat-only actions are safe in the empty state', async () => {
    reset();
    await mount();
    const close = window.close;
    const restoreFlags = withFlags(() => true);
    let closed = 0;
    window.close = () => {
      closed++;
    };
    try {
      for (const action of SHORTCUT_ACTIONS) {
        await set({ route: { name: 'home' } });
        await cmd('shortcut', action.id);
      }
    } finally {
      window.close = close;
      restoreFlags();
    }
    assert.equal(
      calls.some((c: any[]) => c[0] === 'error'),
      false,
    );
    assert.equal(closed, 1);
    await unmount();
  });
  test('focused widgets retain text and modal keys; browser/terminal keys and fallback bindings have one owner', async () => {
    reset({
      route: { name: 'thread', id: 'a' },
      prefs: { fontSize: 14, codeFontSize: 12, keybindings: { pin: 'A', archive: '⌘Dead', back: '⌥ArrowUp' } },
    });
    await mount();
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<div data-composer-chat="side"><input /></div><div class="term-view"><input /></div><div class="browser-pane"><input /></div><div class="later-dialog"><input /></div>';
    document.body.append(wrap);
    const inputs = wrap.querySelectorAll('input');
    const press = async (target: HTMLElement, init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      await act(async () => {
        target.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    inputs[0].focus();
    assert.equal(await press(inputs[0], { key: 'a', code: 'KeyA' }), false);
    assert.equal(getState().pinned.a, undefined);
    const button = document.createElement('button');
    wrap.firstElementChild!.append(button);
    button.focus();
    await press(button, { key: 'a', code: 'KeyA' });
    assert.equal(getState().pinned.side, true);
    await press(button, { key: 'a', code: 'KeyA', repeat: true });
    assert.equal(getState().pinned.side, true);
    await press(button, { key: 'Dead', code: '', metaKey: true });
    await press(button, { key: 'Dead', code: '', metaKey: true, repeat: true });
    const events: any[] = [];
    const receive = (e: Event) => events.push((e as CustomEvent).detail.id);
    window.addEventListener('workspace-shortcut', receive);
    inputs[1].focus();
    await press(inputs[1], { key: 'l', code: 'KeyL', ctrlKey: true });
    await cmd('shortcut', { id: 'command-menu', combo: '⌘K' });
    inputs[2].focus();
    await press(inputs[2], { key: 'r', code: 'KeyR', metaKey: true });
    // the page's zoom, not the window's, while the browser pane has focus
    let restoreFlags = withFlags(() => true);
    await press(inputs[2], { key: '=', code: 'Equal', metaKey: true });
    await press(inputs[2], { key: '-', code: 'Minus', metaKey: true });
    await press(inputs[2], { key: '0', code: 'Digit0', metaKey: true });
    // a <webview> page (view tabs off) has no zoom of its own: the window zooms, as before
    restoreFlags();
    restoreFlags = withFlags((k) => k !== 'shared.browser.viewTabs');
    await press(inputs[2], { key: '=', code: 'Equal', metaKey: true });
    assert.equal(getState().prefs.zoomLevel, 0.5);
    await press(inputs[2], { key: '-', code: 'Minus', metaKey: true });
    await press(inputs[2], { key: '-', code: 'Minus', metaKey: true });
    assert.equal(getState().prefs.zoomLevel, -0.5);
    await press(inputs[2], { key: '0', code: 'Digit0', metaKey: true });
    assert.equal(getState().prefs.zoomLevel, 0);
    await set({ paneTabs: [{ id: 'view', kind: 'browser', browserView: true }], paneActive: 'view' });
    await press(inputs[2], { key: '=', code: 'Equal', metaKey: true });
    assert.equal(getState().prefs.zoomLevel, 0, 'a view tab zooms its page even with the flag off');
    restoreFlags();
    await cmd('shortcut', { id: 'copy-cwd', combo: '⇧⌘C' });
    wrap.lastElementChild!.setAttribute('role', 'dialog');
    inputs[3].focus();
    assert.equal(await press(inputs[3], { key: 'Dead', metaKey: true }), false);
    await set({ diffPanel: { open: true } });
    wrap.lastElementChild!.remove();
    await key({ key: 'Escape', code: 'Escape' });
    assert.equal(getState().diffPanel.open, false);
    assert.equal(await key({ key: 'Meta', code: 'MetaLeft', metaKey: true }), false);
    assert.equal(await key({ key: 'x', code: 'KeyX', isComposing: true }), false);
    await act(async () => {
      const e = new KeyboardEvent('keydown', { key: 'Dead', metaKey: true, cancelable: true });
      e.preventDefault();
      window.dispatchEvent(e);
    });
    assert.deepEqual(events, [
      'clear-terminal',
      'clear-terminal',
      'browser-reload',
      'browser-zoom-in',
      'browser-zoom-out',
      'browser-zoom-reset',
      'browser-zoom-in',
      'browser-copy-url',
    ]);
    window.removeEventListener('workspace-shortcut', receive);
    wrap.remove();
    await unmount();
  });
  test('terminal toggling preserves its existing shell and missing workspace selections recover safely', async () => {
    reset({
      route: { name: 'thread', id: 'a' },
      prefs: { fontSize: 14, codeFontSize: 12, keybindings: {}, defaultTerminal: 'right' },
      paneTabs: [{ id: 'term', kind: 'terminal', ownerChat: 'a' }],
      paneActive: 'term',
      diffPanel: { open: true },
    });
    await mount();
    await cmd('shortcut', 'open-terminal');
    assert.equal(getState().diffPanel.open, false);
    await cmd('shortcut', 'open-terminal');
    assert.equal(getState().diffPanel.open, true);
    assert.equal(getState().paneActive, 'term');
    const input = document.createElement('input');
    input.className = 'side-pane';
    document.body.append(input);
    input.focus();
    await set({ paneActive: 'missing' });
    await cmd('shortcut', 'close-other-tabs');
    await cmd('shortcut', 'next-chat');
    await set({ paneFull: true });
    await cmd('shortcut', 'prev-chat');
    await set({ paneTabs: [], diffPanel: { open: false } });
    await cmd('shortcut', 'cycle-layout');
    await cmd('shortcut', 'full-view');
    await cmd('shortcut', 'close-other-tabs');
    await set({
      route: { name: 'home' },
      paneTabs: [{ id: 'term', kind: 'terminal' }],
      prefs: { ...getState().prefs, defaultTerminal: 'bottom' },
      bottomPanelOpen: false,
    });
    await cmd('shortcut', 'open-terminal');
    assert.equal(getState().bottomPanelOpen, true);
    const composer = document.createElement('div');
    composer.dataset.composerChat = '';
    composer.innerHTML = '<input />';
    document.body.append(composer);
    composer.querySelector('input')!.focus();
    await cmd('shortcut', 'close-other-tabs');
    composer.remove();
    input.remove();
    await unmount();
  });

  test('actual rename modal owns navigation keys and pending approvals retain disjoint app navigation', async () => {
    reset({ route: { name: 'thread', id: 'a' } });
    await mount();
    const close = window.close;
    let closed = 0;
    window.close = () => {
      closed++;
    };
    await cmd('shortcut', 'rename');
    assert.ok(document.querySelector('.sketch-backdrop input'));
    await cmd('shortcut', 'new-chat');
    await cmd('shortcut', 'close-tab');
    assert.equal(getState().route.id, 'a');
    assert.equal(closed, 0);
    await key({ key: 'Escape', code: 'Escape' });
    assert.equal(document.querySelector('.sketch-backdrop'), null);
    const card = document.createElement('div');
    card.className = 'approval-card';
    document.body.append(card);
    await set({ diffPanel: { open: true } });
    await key({ key: 'Escape', code: 'Escape' });
    assert.equal(getState().diffPanel.open, true);
    await cmd('shortcut', 'new-chat');
    assert.equal(getState().route.name, 'home');
    await cmd('shortcut', 'chat-2');
    assert.equal(getState().route.id, 'b');
    card.remove();
    window.close = close;
    await unmount();
  });
  test('chat navigation deduplicates project and recent rows, while native editing remains with text controls', async () => {
    setGroups({
      groups: [{ threads: [{ id: 'a' }, { id: 'b' }] }, { threads: [{ id: 'c' }] }],
      recents: [{ id: 'c' }, { id: 'b' }, { id: 'a' }],
    });
    reset({ route: { name: 'thread', id: 'c' }, prefs: { fontSize: 14, keybindings: { pin: '⌘Z' } } });
    await mount();
    await cmd('shortcut', 'next-chat');
    assert.equal(getState().route.id, 'a');
    await cmd('shortcut', 'prev-chat');
    assert.equal(getState().route.id, 'c');
    await cmd('shortcut', 'chat-4');
    assert.equal(getState().route.id, 'c');
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const press = async (target: HTMLElement) => {
      const e = new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', metaKey: true, bubbles: true, cancelable: true });
      await act(async () => {
        target.dispatchEvent(e);
      });
      return e.defaultPrevented;
    };
    assert.equal(await press(input), false);
    assert.equal(getState().pinned.c, undefined);
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    assert.equal(await press(button), true);
    assert.equal(getState().pinned.c, true);
    input.remove();
    button.remove();
    await unmount();
    setGroups({ groups: [{ threads: [{ id: 'a' }, { id: 'b' }] }], recents: [{ id: 'c' }] });
  });
  test('numbered native, renderer and browser shortcuts open the currently displayed row, with no stale hidden target', async () => {
    reset({ route: { name: 'home' }, prefs: { fontSize: 14, keybindings: { 'chat-2': 'R' } } });
    await mount();
    const sidebar = document.createElement('aside');
    sidebar.className = 'thread-sidebar';
    sidebar.innerHTML =
      '<div data-sidebar-chat="c"></div><div data-sidebar-chat="b"></div><div data-shortcut-recents><div data-sidebar-chat="a"></div></div>';
    document.body.append(sidebar);
    try {
      await cmd('shortcut', 'chat-1');
      assert.equal(getState().route.id, 'c');
      assert.equal(await key({ key: 'r', code: 'KeyR' }), true);
      assert.equal(getState().route.id, 'b');
      await cmd('shortcut', 'recent-1');
      assert.equal(getState().route.id, 'a');
      await set({ diffPanel: { open: true }, paneActive: 'browser' });
      await act(async () => window.dispatchEvent(new CustomEvent('browser-shortcut', { detail: { combo: '⌘1', paneId: 'browser' } })));
      assert.equal(getState().route.id, 'c');
      sidebar.replaceChildren();
      await cmd('shortcut', 'chat-1');
      assert.equal(getState().route.id, 'c', 'an empty rendered list does not fall back to a hidden project chat');
      sidebar.remove();
      await cmd('shortcut', 'chat-1');
      assert.equal(getState().route.id, 'a', 'navigation without a visible sidebar retains its original fallback');
    } finally {
      sidebar.remove();
      await unmount();
    }
  });
}
