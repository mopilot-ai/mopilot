// Pane-tab sizing, ownership, menus and geometry through the real title bar on every harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, type ComponentType } from 'react';
import { click, render, press, flush } from './shell-chrome-kit.ts';
import { scrollObserver } from './scroll-observer.ts';

export function titleBarPaneTabsTests({
  TitleBar,
  reset,
  set,
  calls,
  store,
  styles,
}: {
  TitleBar: ComponentType;
  reset: (patch?: any) => void;
  set: (patch: any) => Promise<unknown>;
  calls: any[][];
  store: { getState: () => any };
  styles: () => HTMLStyleElement;
}) {
  test('a hidden retained pane offers restoration instead of tab creation on every harness', async () => {
    for (const family of ['codex', 'claude', 'acp']) {
      const id = `${family}:t1`;
      for (const kind of ['browser', 'terminal', 'file', 'changes', 'chat', 'tasks', 'outputs']) {
        const tabs = [
          { id: 'selected', kind, title: 'Selected', ownerChat: id, threadId: id },
          { id: 'newer', kind: 'browser', title: 'Newer', ownerChat: id },
          { id: 'foreign', kind: 'browser', title: 'Foreign', ownerChat: 'other' },
        ];
        reset({
          route: { name: 'thread', id },
          threads: { [id]: { id, title: 'Main chat', cwd: '/work/project' } },
          paneTabs: tabs,
          paneActive: 'selected',
          diffPanel: { open: true, file: 'retained.ts', scope: 'branch' },
          paneFull: true,
        });
        const { host, unmount } = await render(createElement(TitleBar));
        try {
          await click(host.querySelector('[aria-label="Hide tabs"]'));
          const reopen = host.querySelector<HTMLButtonElement>('[aria-label="Show tabs"]');
          assert.ok(reopen, `${family}/${kind}: a hidden nonempty pane needs a restore action`);
          assert.equal(reopen.parentElement!.getAttribute('data-tooltip'), 'Show tabs');
          assert.equal(reopen.parentElement!.getAttribute('data-shortcut'), null, 'Cmd+T belongs to New tab, not restore');
          assert.equal(host.querySelector('[aria-label="New tab"]'), null);
          await click(reopen);
          assert.deepEqual(calls, [['showPaneTab']], 'restore delegates to the live, scope-checked store action');
          assert.equal(store.getState().paneTabs, tabs);
          assert.equal(store.getState().paneActive, 'selected');
          assert.equal(store.getState().paneFull, false);
          await set({ diffPanel: { open: true } });
          await click(host.querySelector('.tb-tabs [aria-label="New tab"]'));
          assert.deepEqual(calls.at(-1), ['openPaneTab', 'browser'], 'the explicit add button still creates a tab');
        } finally {
          await unmount();
        }
      }
    }
  });

  test('the hidden-pane control follows visible tabs across split focus and the empty state', async () => {
    reset({
      route: { name: 'thread', id: 'codex:t1' },
      paneTabs: [
        { id: 'mine', kind: 'browser', title: 'Mine', ownerChat: 'codex:t1' },
        { id: 'foreign', kind: 'browser', title: 'Foreign', ownerChat: 'claude:other' },
      ],
      paneActive: 'foreign',
      diffPanel: { open: false, file: 'retained.ts', scope: 'branch' },
    });
    const { host, unmount } = await render(createElement(TitleBar));
    try {
      await click(host.querySelector('[aria-label="Show tabs"]'));
      assert.deepEqual(calls, [['showPaneTab']]);
      await set({ split: { panes: [{ chatId: 'claude:other', weight: 1 }], focus: 'claude:other', primaryWeight: 1 } });
      await click(host.querySelector('[aria-label="Show tabs"]'));
      assert.deepEqual(calls, [['showPaneTab'], ['showPaneTab']]);
      await set({ diffPanel: { open: false }, paneActive: 'removed', paneTabs: [] });
      assert.equal(host.querySelector('[aria-label="Show tabs"]'), null);
      await click(host.querySelector('[aria-label="New tab"]'));
      assert.deepEqual(calls.at(-1), ['openPaneTab', 'browser'], 'closing the last tab restores the empty-view action');
    } finally {
      await unmount();
    }
  });

  test('an empty focused view offers New tab even when another chat has retained tabs', async () => {
    for (const route of [{ name: 'home' }, { name: 'thread', id: 'codex:t1' }]) {
      reset({ route, paneTabs: [{ id: 'foreign', kind: 'browser', ownerChat: 'claude:other' }], paneActive: 'foreign' });
      const { host, unmount } = await render(createElement(TitleBar));
      try {
        assert.equal(host.querySelector('[aria-label="Show tabs"]'), null);
        await click(host.querySelector('[aria-label="New tab"]'));
        assert.deepEqual(calls, [['openPaneTab', 'browser']]);
      } finally {
        await unmount();
      }
    }
  });

  test('a pane-tab menu animation cannot scroll back to a different selected tab', async () => {
    const reveals: Element[] = [];
    const reveal = mock.method(HTMLElement.prototype, 'scrollIntoView', function (this: HTMLElement) {
      reveals.push(this);
    });
    reset({
      diffPanel: { open: true },
      paneTabs: [
        { id: 'first', kind: 'browser', title: 'First' },
        { id: 'next', kind: 'browser', title: 'Next' },
      ],
      paneActive: 'first',
    });
    const { host, unmount } = await render(createElement(TitleBar));
    try {
      await act(async () =>
        host.querySelector('[aria-label="Next"]')!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      );
      await flush();
      const menu = host.querySelector('[role="menu"]')!;
      assert.ok(menu);
      reveals.length = 0;
      await act(async () => menu.dispatchEvent(new Event('animationend', { bubbles: true })));
      assert.deepEqual(reveals, [], 'a menu animation must not move its anchor or reveal another tab');
    } finally {
      await unmount();
      reveal.mock.restore();
    }
  });

  test('full-view chat title growth and a preceding tab closing keep the current selection visible', async (t) => {
    const layout = scrollObserver(t);
    const reveals: Element[] = [];
    const reveal = mock.method(HTMLElement.prototype, 'scrollIntoView', function (this: HTMLElement) {
      reveals.push(this);
    });
    reset({
      diffPanel: { open: true },
      paneFull: true,
      paneTabs: [
        { id: 'before', kind: 'browser', title: 'Before' },
        { id: 'active', kind: 'browser', title: 'Active' },
        { id: 'after', kind: 'browser', title: 'After' },
      ],
      paneActive: 'active',
    });
    const { host, unmount } = await render(createElement(TitleBar));
    try {
      const active = host.querySelector('.tb-tab.active')!;
      const before = host.querySelector('[aria-label="Before"]')!;
      const back = host.querySelector('.chat-tab')!;
      const id = store.getState().route.id;
      await set({ threads: { [id]: { ...store.getState().threads[id], title: 'The main chat now has a much longer title' } } });
      reveals.length = 0;
      await act(async () => layout.notify(back));
      assert.deepEqual(reveals, [active], 'the back-to-chat label has geometry outside paneTabs');
      await set({ paneTabs: store.getState().paneTabs.filter((tab: any) => tab.id !== 'before') });
      await flush();
      assert.ok(before.classList.contains('tab-leaving'));
      reveals.length = 0;
      await act(async () => layout.notify(before));
      assert.deepEqual(reveals, [active], 'the selected tab follows the closing width transition');
    } finally {
      await unmount();
      reveal.mock.restore();
    }
    assert.equal(layout.watching, 0, 'closing the header releases geometry observers');
  });

  test('compact agent tabs keep their badge and close control through activity, take-over and chat changes on every harness', async () => {
    const sheet = styles();
    try {
      for (const family of ['codex', 'claude', 'acp']) {
        const id = `${family}:t1`;
        const tab = { id: 'agent', kind: 'browser', agentChat: id, title: 'Research', url: 'https://example.test/research' };
        const view = {
          tabId: 'page',
          tabKey: null,
          kind: 'tab',
          active: true,
          created: true,
          takenOver: false,
          mark: 'deliverable',
          access: 'read',
          origin: 'https://example.test',
        };
        reset({
          route: { name: 'thread', id },
          threads: { [id]: { id, title: 'Main chat', cwd: '/work/project' } },
          diffPanel: { open: true },
          paneWidth: 300,
          paneTabs: [tab],
          paneActive: tab.id,
          agentTabs: { [id]: [view] },
        });
        const { host, unmount } = await render(createElement(TitleBar));
        try {
          const row = () => host.querySelector<HTMLElement>('.tb-tab-list .tb-tab')!;
          assert.equal(row().classList.contains('agent-active'), true, family);
          assert.match(row().title, /Opened by the agent to show you a result/);
          assert.ok(row().querySelector('svg[aria-label="Opened by the agent to show you a result"]'));
          assert.equal(getComputedStyle(row()).flexBasis, 'auto');
          assert.equal(getComputedStyle(row().querySelector('.tb-tab-close')!).flexShrink, '0');
          await set({ agentTabs: { [id]: [{ ...view, takenOver: true }] } });
          assert.equal(row().classList.contains('agent-active'), false, 'take-over ends the active indication');
          assert.match(row().title, /Opened by the agent to show you a result/, 'the result provenance remains');
          await set({ agentTabs: { [id]: [{ ...view, active: false }] } });
          assert.equal(row().classList.contains('agent-active'), false, 'an idle agent does not pulse');
          await set({ paneTabs: [{ ...tab, agentTab: 'page' }], agentTabs: { [id]: [{ ...view, tabKey: 'page' }] } });
          assert.equal(row().classList.contains('agent-active'), true, 'explicit browser-tab keys retain their owner');
          await set({ route: { name: 'thread', id: 'other-chat' } });
          assert.equal(row(), null, 'another chat cannot see this agent tab');
          await set({ route: { name: 'thread', id } });
          assert.equal(row().classList.contains('agent-active'), true);
          await set({ agentTabs: {} });
          assert.equal(row().classList.contains('agent-active'), false, 'a withdrawn agent snapshot is safe');
          assert.equal(row().title, tab.url);
          await click(row().querySelector('.tb-tab-close'));
          assert.deepEqual(calls, [['closePaneTab', tab.id]]);
        } finally {
          await unmount();
        }
      }
    } finally {
      sheet.remove();
    }
  });

  test('pane tabs use their label width and scroll independently of the panel controls for every harness', async () => {
    const sheet = styles();
    try {
      for (const family of ['codex', 'claude', 'acp']) {
        const id = `${family}:t1`;
        reset({
          route: { name: 'thread', id },
          threads: { [id]: { id, title: 'Main chat', cwd: '/work/project' } },
          diffPanel: { open: true },
          paneWidth: 300,
          paneTabs: [
            { id: 'side', kind: 'chat', threadId: `${family}:side` },
            { id: 'browser', kind: 'browser', title: 'A long page title '.repeat(30) },
            { id: 'changes', kind: 'changes' },
          ],
          paneActive: 'side',
        });
        const { host, unmount } = await render(createElement(TitleBar));
        try {
          const strip = host.querySelector<HTMLElement>('.tb-tabs')!;
          const list = strip.querySelector<HTMLElement>('.tb-tab-list');
          assert.ok(list, 'tabs need their own scroll area so the controls cannot be pushed out');
          const tabs = [...list.querySelectorAll<HTMLElement>('.tb-tab')];
          assert.equal(tabs.length, 3, family);
          assert.equal(getComputedStyle(list).overflowX, 'auto', family);
          assert.match(getComputedStyle(list).minWidth, /^0(?:px)?$/, family);
          for (const tab of tabs) {
            const style = getComputedStyle(tab);
            assert.equal(style.flexBasis, 'auto', 'short titles must not reserve a fixed tab width');
            assert.equal(style.flexShrink, '0', 'overflow must scroll rather than hide the icon and close target');
            assert.equal(style.maxWidth, '100%', 'tabs still fit a viewport narrowed by panel and window controls');
            assert.equal(getComputedStyle(tab.querySelector('span')!).textOverflow, 'ellipsis');
            assert.equal(getComputedStyle(tab.querySelector('.tb-tab-close')!).flexShrink, '0');
          }
          for (const label of ['New tab', 'Enter full view', 'Hide tabs']) {
            const button = strip.querySelector(`[aria-label="${label}"]`)!;
            assert.ok(button, label);
            assert.equal(list.contains(button), false, `${label} stays outside the scroller`);
            assert.equal(getComputedStyle(button.parentElement!).flexShrink, '0', label);
          }
          const add = strip.querySelector('[aria-label="New tab"]')!.parentElement!;
          assert.equal(list.nextElementSibling, add, 'New tab immediately follows the tab list');
          assert.ok(add.nextElementSibling!.classList.contains('flex1'), 'spare header space belongs after New tab');
          await press(tabs[1], 'Enter');
          assert.equal(store.getState().paneActive, 'browser', family);
          await click(strip.querySelector('[aria-label="New tab"]'));
          assert.deepEqual(calls, [['openPaneTab', 'browser']]);
          await set({ paneFull: true });
          const back = list.querySelector<HTMLElement>('.chat-tab')!;
          assert.equal(getComputedStyle(back).flexBasis, 'auto', 'back-to-chat uses the same compact sizing');
          await press(back, 'Enter');
          assert.equal(store.getState().paneFull, false);
        } finally {
          await unmount();
        }
      }
    } finally {
      sheet.remove();
    }
  });

  test('the selected pane tab stays visible through selection, title changes, resizing and late layout notifications', async (t) => {
    const layout = scrollObserver(t);
    const reveal = mock.method(HTMLElement.prototype, 'scrollIntoView', function (this: HTMLElement, options: ScrollIntoViewOptions) {
      reveals.push([this.getAttribute('aria-label'), options]);
    });
    const reveals: unknown[][] = [];
    reset({
      diffPanel: { open: true },
      paneTabs: [{ id: 'first', kind: 'browser', title: 'First' }],
      paneActive: 'first',
    });
    const { host, unmount } = await render(createElement(TitleBar));
    const expected = (label: string) => [label, { block: 'nearest', inline: 'nearest' }];
    try {
      assert.deepEqual(reveals.at(-1), expected('First'));
      const firstTab = host.querySelector('.tb-tab.active')!;
      await set({ paneTabs: [...store.getState().paneTabs, { id: 'next', kind: 'browser', title: 'Next' }], paneActive: 'next' });
      await flush();
      assert.deepEqual(reveals.at(-1), expected('Next'));
      reveals.length = 0;
      await act(async () => layout.notify(host.querySelector('.tb-tab.active')!));
      assert.deepEqual(reveals, [expected('Next')], 'entrance can increase the scroll width after the first reveal');
      reveals.length = 0;
      await act(async () => layout.notify(firstTab));
      assert.deepEqual(reveals, [expected('Next')], 'a late animation reveals the current selection');
      await set({
        paneTabs: store.getState().paneTabs.map((tab: any) => (tab.id === 'next' ? { ...tab, title: 'Loaded page title' } : tab)),
      });
      await act(async () => layout.notify(host.querySelector('.tb-tab.active')!));
      assert.deepEqual(reveals.at(-1), expected('Loaded page title'), 'a loaded page title can grow after its tab entrance');
      await set({ paneWidth: 260 });
      await act(async () => layout.notify(host.querySelector('.tb-tab-list')!));
      assert.deepEqual(reveals.at(-1), expected('Loaded page title'));
      await set({ paneActive: 'first' });
      await flush();
      assert.deepEqual(reveals.at(-1), expected('First'));
      await set({ diffPanel: { open: false } });
      reveals.length = 0;
      await set({ diffPanel: { open: true } });
      assert.deepEqual(reveals, [expected('First')]);
      await set({ paneTabs: [], paneActive: null });
      reveals.length = 0;
      await act(async () => layout.notify(host.querySelector('.tb-tab-list')!));
      assert.deepEqual(reveals, [], 'an empty strip has no active tab to reveal');
    } finally {
      await unmount();
      reveal.mock.restore();
    }
  });
}
