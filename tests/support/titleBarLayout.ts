// Behavioral layout guards for the real title bar across sidebar, platform, fullscreen and pane states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act, createElement, type ComponentType } from 'react';
import { native } from '../../src/lib/native.ts';
import { appCss } from './app-css.ts';
import { fakeNative } from './ports/native.ts';
import { click, flush, render, press } from './shell-chrome-kit.ts';
import { titleBarPaneTabsTests } from './titleBarPaneTabs.ts';

function titleBarStyles() {
  const sheet = document.createElement('style');
  sheet.textContent = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8') + appCss();
  document.head.append(sheet);
  return sheet;
}

export function titleBarLayoutTests({
  TitleBar,
  reset,
  set,
  calls,
  store,
}: {
  TitleBar: ComponentType;
  reset: (patch?: any) => void;
  set: (patch: any) => Promise<unknown>;
  calls: any[][];
  store: { getState: () => any };
}) {
  titleBarPaneTabsTests({ TitleBar, reset, set, calls, store, styles: titleBarStyles });

  test('the title bar follows the active session’s registered execution location', async () => {
    const chatId = 'acp:host-codex:remote';
    const machine = { id: 'ssh:box', name: 'Build box', status: 'online', note: '' };
    const bridge = fakeNative({
      host: {
        access: async () => true,
        remoteChats: async () => [{ chatId, hostId: machine.id }],
        machines: async () => ({ machines: [machine], resolved: true }),
      },
    });
    const previous = native.host;
    native.host = bridge.host;
    reset({ route: { name: 'thread', id: chatId }, threads: { [chatId]: { id: chatId, title: 'Remote', cwd: '/srv/app' } } });
    const { host, unmount } = await render(createElement(TitleBar));
    try {
      const mark = () => host.querySelector('.tb-title .host-mark');
      await flush();
      assert.ok(mark()?.querySelector('.lucide-square-terminal'));
      assert.equal(mark()?.getAttribute('title'), 'On Build box');
      const cloud = { provider: 'oci', id: 'vm', region: 'us', size: 'small', network: 'full' };
      await act(async () => bridge.emit('host.onMachines', { machines: [{ ...machine, cloud }], resolved: true }));
      assert.ok(mark()?.querySelector('.lucide-cloud'));
      await act(async () => bridge.emit('host.onMachines', { machines: [], resolved: true }));
      assert.ok(mark()?.querySelector('.lucide-square-terminal'));
      assert.equal(mark()?.getAttribute('title'), 'On ssh:box');
    } finally {
      await unmount();
      bridge.emit('host.onAccess', false);
      native.host = previous;
    }
  });

  test('navigation buttons: back/forward follow history, the sidebar toggle flips and moves the title', async () => {
    reset();
    const { host, unmount } = await render(createElement(TitleBar));
    const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    const tip = () => button('Toggle sidebar').parentElement!.getAttribute('data-tooltip');
    assert.equal(button('Back').disabled, true);
    assert.equal(button('Forward').disabled, true);
    await set({ back: [{}], forward: [{}] });
    await click(button('Back'));
    await click(button('Forward'));
    assert.deepEqual(calls, [['goBack'], ['goForward']]);
    const expanded = () => host.querySelector('.titlebar-main')!.classList.contains('sidebar-open');
    assert.equal(tip(), 'Hide sidebar');
    assert.equal(expanded(), true);
    await click(button('Toggle sidebar'));
    assert.equal(store.getState().sidebarOpen, false);
    assert.equal(tip(), 'Show sidebar');
    assert.equal(expanded(), false);
    await unmount();
  });

  test('double-clicking the bar itself maximizes the window; double-clicking a child does not', async () => {
    reset({ fullscreen: true });
    const { host, unmount } = await render(createElement(TitleBar));
    const header = host.querySelector('header')!;
    const doubleClick = (el: Element) => act(async () => el.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
    assert.equal(header.className, 'titlebar fullscreen');
    await doubleClick(host.querySelector('.titlebar-nav')!);
    assert.deepEqual(calls, []);
    await doubleClick(header);
    assert.deepEqual(calls, [['toggleMaximize']]);
    await unmount();
  });

  test('navigation and title keep separate intrinsic tracks through sidebar, fullscreen, platform and pane changes', async () => {
    const sheet = titleBarStyles();
    const platform = document.documentElement.dataset.platform;
    const captionWidth = document.documentElement.style.getPropertyValue('--wco-w');
    document.documentElement.style.setProperty('--wco-w', '138px');
    try {
      for (const os of ['darwin', 'win32', 'linux']) {
        document.documentElement.dataset.platform = os;
        reset();
        const { host, unmount } = await render(createElement(TitleBar));
        try {
          for (const fullscreen of [false, true]) {
            await set({ fullscreen });
            for (const paneWidth of [0, 400]) {
              await set({ diffPanel: { open: paneWidth > 0 }, paneWidth });
              for (const open of [false, true, false, true]) {
                await click(host.querySelector('[aria-label="Toggle sidebar"]'));
                const nav = host.querySelector<HTMLElement>('.titlebar-nav')!;
                const center = host.querySelector<HTMLElement>('.titlebar-center')!;
                const main = nav.parentElement!;
                const label = `${os}, fullscreen ${fullscreen}, pane ${paneWidth}, sidebar ${open}`;
                // Normal-flow grid items cannot cover each other's hit targets, even when the title has no room.
                for (const element of [nav, center]) {
                  assert.ok(!['absolute', 'fixed'].includes(getComputedStyle(element).position), label);
                  assert.equal(element.style.left, '', label);
                }
                assert.equal(center.parentElement, main, label);
                const actions = host.querySelector<HTMLElement>('.titlebar-right')!;
                assert.deepEqual([...main.children], [nav, center, actions], label);
                assert.equal(getComputedStyle(main).display, 'grid', label);
                assert.match(getComputedStyle(main).gridTemplateColumns, /minmax\(max-content, .+\) minmax\(0, 1fr\) max-content/, label);
                assert.equal(getComputedStyle(main).columnGap, '12px', label);
                assert.equal(getComputedStyle(main).pointerEvents, 'none', label);
                assert.equal(getComputedStyle(nav).pointerEvents, 'auto', label);
                assert.equal(getComputedStyle(nav).justifySelf, 'start', label);
                assert.match(getComputedStyle(center).minWidth, /^0(?:px)?$/, label);
                assert.equal(main.classList.contains('sidebar-open'), open, label);
                assert.equal(main.classList.contains('beside-pane'), paneWidth > 0, label);
                assert.equal(main.style.right, `${paneWidth}px`, label);
                // macOS: clear of the window buttons, 88px at Actual Size and more zoomed out (electron/app/zoom.cjs);
                // the test DOM leaves max() unresolved, so the rule is read at Actual Size (--zoom 1)
                if (fullscreen || os === 'win32') assert.equal(getComputedStyle(main).paddingLeft, '12px', label);
                else
                  assert.equal(
                    getComputedStyle(host.querySelector('.titlebar')!).getPropertyValue('--titlebar-nav-inset').trim(),
                    'max(88px, calc(42px + 46px / 1))',
                    label,
                  );
                assert.equal(Number.parseFloat(getComputedStyle(main).marginRight) || 0, os === 'win32' && !paneWidth ? 138 : 0, label);
                assert.equal(Number.parseFloat(getComputedStyle(actions).marginRight) || 0, 0, 'caption space is reserved once');
                assert.equal(host.querySelectorAll('.titlebar-nav button').length, 3, label);
                assert.equal(host.querySelector('.tb-title-text')?.textContent, 'Fix: the <bug>?', label);
              }
            }
          }
        } finally {
          await unmount();
        }
      }
    } finally {
      if (platform === undefined) delete document.documentElement.dataset.platform;
      else document.documentElement.dataset.platform = platform;
      if (captionWidth) document.documentElement.style.setProperty('--wco-w', captionWidth);
      else document.documentElement.style.removeProperty('--wco-w');
      sheet.remove();
    }
  });

  test('long titles and rename inputs stay bounded beside navigation for every harness, including an empty route', async () => {
    const sheet = titleBarStyles();
    try {
      for (const id of ['codex:t1', 'claude:t1', 'acp:t1']) {
        const title = 'A long project title '.repeat(30);
        reset({ sidebarOpen: false, route: { name: 'thread', id }, threads: { [id]: { id, title, cwd: '/work/project' } } });
        const { host, unmount } = await render(createElement(TitleBar));
        try {
          const center = host.querySelector<HTMLElement>('.titlebar-center')!;
          const text = host.querySelector<HTMLElement>('.tb-title-text')!;
          assert.equal(getComputedStyle(center).overflow, 'hidden', id);
          assert.equal(getComputedStyle(text).textOverflow, 'ellipsis', id);
          assert.equal(text.textContent, title, id);
          await act(async () => text.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
          const input = host.querySelector<HTMLInputElement>('.tb-rename')!;
          assert.match(getComputedStyle(input).minWidth, /^0(?:px)?$/, id);
          assert.equal(getComputedStyle(input).maxWidth, '100%', id);
          assert.equal(input.value, title, id);
          await press(input, 'Escape');
          await set({ route: { name: 'home' } });
          assert.equal(host.querySelector('.tb-title'), null, id);
          assert.equal(host.querySelectorAll('.titlebar-nav button').length, 3, id);
          await click(host.querySelector('[aria-label="Toggle sidebar"]'));
          assert.ok(host.querySelector('.titlebar-main.sidebar-open'), id);
        } finally {
          await unmount();
        }
      }
    } finally {
      sheet.remove();
    }
  });

  test('optional title-bar actions have an intrinsic track beside a pane and release it in full view', async () => {
    const sheet = titleBarStyles();
    reset({ sidebarOpen: false, prefs: { bottomPanelControl: true }, diffPanel: { open: true }, paneWidth: 400 });
    const { host, unmount } = await render(createElement(TitleBar));
    try {
      const main = host.querySelector('.titlebar-nav')!.parentElement!;
      const actions = host.querySelector<HTMLElement>('.titlebar-right')!;
      assert.equal(actions.parentElement, main, 'the terminal button must take real space from the title');
      assert.ok(!['absolute', 'fixed'].includes(getComputedStyle(actions).position));
      assert.equal(actions.style.right, '');
      assert.equal(main.style.right, '400px', 'only the pane is reserved outside the shared grid');
      assert.equal(getComputedStyle(main).paddingRight, '10px');
      assert.equal(getComputedStyle(actions).pointerEvents, 'auto');
      assert.equal(actions.querySelectorAll('button').length, 3);
      await set({ prefs: { bottomPanelControl: false } });
      assert.equal(actions.querySelectorAll('button').length, 2);
      await set({ paneFull: true });
      assert.equal(actions.hidden, true);
      assert.equal(getComputedStyle(actions).display, 'none');
      await set({ paneFull: false, diffPanel: { open: false } });
      assert.equal(getComputedStyle(actions).display, 'flex');
      assert.equal(main.style.right, '0px');
      assert.equal(getComputedStyle(main).paddingRight, '9px');
    } finally {
      await unmount();
      sheet.remove();
    }
  });
}
