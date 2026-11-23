// Real title-bar wiring of the pane tab menu (Duplicate, Rename in place, the Close items' strip, the muted mark), with only
// the store actions and the browser operation mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { toolLayoutScope, toolLayout, resetToolLayouts } from '../../src/lib/toolPaneLayout.ts';
import { render, click, byText, press } from './shell-chrome-kit.ts';

/** The tab menu's store actions for titleBarUI's store mock, recorded by `log`. */
export const tabMenuStoreExports = (log: (name: string) => (...a: any[]) => void) => ({
  showPaneTab: log('showPaneTab'),
  closePaneTab: log('closePaneTab'),
  closeOtherPaneTabs: log('closeOtherPaneTabs'),
  openBrowserTabAfter: log('openBrowserTabAfter'),
  renamePaneTab: log('renamePaneTab'),
});

const contextMenu = (el: Element) =>
  act(async () => el.dispatchEvent(new (globalThis as any).window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));

export function browserTabMenuTests({ reset, set, TitleBar, calls, THREAD }: any) {
  test('browser tab context menu duplicates its exact tab, shows pending state and closes without changing other tabs', async () => {
    reset();
    await set({
      diffPanel: { open: true },
      paneTabs: [{ id: 'browser-one', kind: 'browser', title: 'Browser one', ownerChat: THREAD.id }],
      paneActive: 'browser-one',
    });
    const { host, unmount } = await render(createElement(TitleBar));
    const tab = host.querySelector('[aria-label="Browser one"]')!;
    await contextMenu(tab);
    await click(byText(host, 'Duplicate'));
    assert.deepEqual(calls, [['duplicate', 'browser-one']]);
    await set({ paneTabs: [{ id: 'browser-one', kind: 'browser', title: 'Browser one', ownerChat: THREAD.id, duplicating: true }] });
    assert.equal((byText(host, 'Duplicating…') as HTMLButtonElement).disabled, true);
    await click(host.querySelector('[data-menu-close]'));
    assert.equal(host.querySelector('[role=menu]'), null);
    await unmount();
  });

  test("the strip's tab menu: Close items count the shown tabs, Rename edits the tab in place, a renamed or muted tab says so", async () => {
    reset();
    await set({
      diffPanel: { open: true },
      paneTabs: [
        { id: 'changes', kind: 'changes' },
        { id: 'hidden', kind: 'browser', agentChat: 'codex:other', title: 'Hidden' },
        { id: 'b1', kind: 'browser', title: 'Page', customTitle: 'Mine', muted: true, url: 'https://a.test/', ownerChat: THREAD.id },
      ],
      paneActive: 'b1',
    });
    const { host, unmount } = await render(createElement(TitleBar));
    const strip = host.querySelector('.tb-tabs')!;
    const tabs = () => [...strip.querySelectorAll('.tb-tab:not(.chat-tab)')];
    assert.deepEqual(
      tabs().map((t) => t.getAttribute('aria-label')),
      ['Changes', 'Mine'],
    );
    assert.ok(tabs()[1].querySelector('svg[aria-label="Muted"]'));
    assert.ok(tabs()[1].querySelector('button[aria-label="Close Mine tab"]'), "the close button says the tab's own name");
    assert.equal(tabs()[0].querySelector('svg[aria-label="Muted"]'), null);
    // the last shown tab: nothing to its right (another chat's tab between them is not shown)
    await contextMenu(tabs()[1]);
    let menu = host.querySelector('[role=menu]')!;
    assert.equal((byText(menu, 'Close other tabs') as HTMLButtonElement).disabled, false);
    assert.equal((byText(menu, 'Close tabs to the right') as HTMLButtonElement).disabled, true);
    assert.ok(byText(menu, 'Unmute tab'));
    await click(byText(menu, 'Rename'));
    const input = tabs()[1].querySelector('input')!;
    assert.equal(input.value, 'Mine');
    input.value = 'Ours';
    await press(input, 'Enter');
    assert.deepEqual(calls, [['renamePaneTab', 'b1', 'Ours']]);
    assert.equal(tabs()[1].querySelector('input'), null);
    await click(host.querySelector('[data-menu-close]'));
    // the first of two: a tab to its right
    await contextMenu(tabs()[0]);
    menu = host.querySelector('[role=menu]')!;
    assert.equal((byText(menu, 'Close tabs to the right') as HTMLButtonElement).disabled, false);
    await unmount();
  });
  test('the real tab strip splits a visible target beside the selected tool and below it without foreign tabs', async () => {
    resetToolLayouts();
    reset();
    await set({
      diffPanel: { open: true },
      paneTabs: [
        { id: 'files', kind: 'files' },
        { id: 'shell', kind: 'terminal', title: 'Shell', ownerChat: THREAD.id },
        { id: 'foreign', kind: 'browser', ownerChat: 'other' },
      ],
      paneActive: 'files',
    });
    const v = await render(createElement(TitleBar));
    await contextMenu(v.host.querySelector('[aria-label="Shell"]')!);
    await click(byText(v.host, 'Show beside current tool'));
    const scope = toolLayoutScope(THREAD.id);
    assert.deepEqual(toolLayout(scope).ids, ['files', 'shell']);
    assert.equal(toolLayout(scope).axis, 'columns');
    assert.equal(v.host.querySelector('[aria-label="Shell"]')!.getAttribute('aria-current'), 'true');
    assert.equal(v.host.querySelector('[aria-label="foreign"]'), null);
    await v.unmount();
    resetToolLayouts();
    reset();
    await set({
      diffPanel: { open: true },
      paneTabs: [
        { id: 'files', kind: 'files' },
        { id: 'shell', kind: 'terminal', title: 'Shell' },
      ],
      paneActive: 'files',
    });
    const below = await render(createElement(TitleBar));
    await contextMenu(below.host.querySelector('[aria-label="Shell"]')!);
    await click(byText(below.host, 'Show below current tool'));
    assert.equal(toolLayout(scope).axis, 'rows');
    await below.unmount();
    resetToolLayouts();
  });
}
