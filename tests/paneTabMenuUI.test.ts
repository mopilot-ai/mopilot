// The pane tab context menu (src/components/titleBar/PaneTabMenu.tsx) and the live-page registry behind its Reload and Mute
// (src/session/browserTabPage.ts), with the store, main and the menu primitives faked.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { fakeStore, popoverExports, render, click, byText, maybeText, press, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: unknown[][] = [];
const log =
  (name: string) =>
  (...a: unknown[]) => {
    calls.push([name, ...a]);
  };
const store = fakeStore<any>({ paneTabs: [] });
/** what main answers setAudioMuted with, or the error it rejects with */
let muteAnswer: (muted: boolean) => Promise<boolean> = async (muted) => muted;

stubStore({
  useStore: store.useStore,
  setState: store.setState,
  closePaneTab: log('closePaneTab'),
  closeOtherPaneTabs: log('closeOtherPaneTabs'),
  openBrowserTabAfter: log('openBrowserTabAfter'),
  renamePaneTab: log('renamePaneTab'),
  openPaneTab: log('openPaneTab'),
  toast: log('toast'),
  toastFailure: (what: string) => (e: any) => calls.push(['toast', `${what}: ${e?.message ?? e}`, 'error']),
});
mock.module('../src/store/browserDuplicate.ts', {
  namedExports: { browserDuplication: { duplicate: async (id: string) => calls.push(['duplicate', id]) } },
});
installNativeStub({
  clipboard: { write: async (text: string) => calls.push(['clipboard', text]) },
  shell: { openExternal: async (url: string) => calls.push(['openExternal', url]) },
  browser: {
    setAudioMuted: (id: number, muted: boolean) => (calls.push(['setAudioMuted', id, muted]), muteAnswer(muted)),
  },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
const { PaneTabMenu, PaneTabRename, browserTabTitle } = await import('../src/components/titleBar/PaneTabMenu.tsx');
const { browserTabPage, useBrowserTabPage } = await import('../src/session/browserTabPage.ts');

const WEB = { id: 'b1', kind: 'browser', url: 'https://docs.test/a', title: 'Docs' };
beforeEach(() => {
  calls.length = 0;
  muteAnswer = async (muted) => muted;
  store.reset({ paneTabs: [WEB, { id: 'b9', kind: 'browser' }] });
});

/** The menu over the store's copy of tab `id`, as the tab strip renders it. */
function Strip({ id, hasOthers = true, hasRight = true }: { id: string; hasOthers?: boolean; hasRight?: boolean }) {
  const tab = store.useStore((s: any) => s.paneTabs.find((t: any) => t.id === id));
  return h(PaneTabMenu, { tab, hasOthers, hasRight, onRename: log('onRename'), 'aria-label': 'tab' }, h('span', null, 'label'));
}
/** A BrowserPanel's page as the registry sees it. */
function Page({ id, pageId = 7, muted = false, tag = 'page' }: { id: string; pageId?: number | null; muted?: boolean; tag?: string }) {
  const page = useBrowserTabPage(id, { reload: log(`reload:${tag}`), pageId: () => pageId, muted });
  (Page as any).bound = page.bound;
  return null;
}
const openMenu = async (host: Element) => {
  await act(async () =>
    host
      .querySelector('[aria-label="tab"]')!
      .dispatchEvent(new (globalThis as any).window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
  );
  return host.querySelector('[role=menu]')!;
};
/** The menu's items and separators, top to bottom. */
const layout = (menu: Element) =>
  [...menu.querySelectorAll('[role=menuitem], hr')].map((el) => (el.tagName === 'HR' ? '—' : el.textContent));

test('splitting is unavailable for absent, already shown, empty and full arrangements', async () => {
  const { rememberToolLayout, resetToolLayouts } = await import('../src/lib/toolPaneLayout.ts');
  for (const [available, ids, front] of [
    [['current'], ['current'], 'current'],
    [['b1'], ['b1'], 'b1'],
    [['b1'], [], ''],
    [['a', 'b', 'c', 'd', 'b1'], ['a', 'b', 'c', 'd'], 'a'],
  ] as const) {
    resetToolLayouts();
    rememberToolLayout('menu-limit', { ids, active: front, weights: ids.map(() => 1), axis: 'rows' });
    const v = await render(
      h(PaneTabMenu, {
        tab: { ...WEB, kind: 'browser' },
        hasOthers: false,
        hasRight: false,
        onRename() {},
        'aria-label': 'tab',
        arrangement: { scope: 'menu-limit', available: [...available], front, select: log('select') },
      }),
    );
    const menu = await openMenu(v.host);
    for (const label of ['Show beside current tool', 'Show below current tool']) {
      const item = byText(menu, label) as HTMLButtonElement;
      assert.equal(item.disabled, true);
      await click(item);
    }
    assert.deepEqual(calls, []);
    await v.unmount();
  }
  resetToolLayouts();
});

test("a web tab's menu matches ChatGPT's order, icons and grouping, with no shortcuts, and acts on that tab", async () => {
  const { host, unmount } = await render(h(Strip, { id: 'b1' }));
  assert.equal(host.querySelector('[role=menu]'), null);
  const menu = await openMenu(host);
  assert.deepEqual(layout(menu), [
    'New tab to the right',
    'Reload',
    'Duplicate',
    'Copy URL',
    'Open in external browser',
    '—',
    'Rename',
    'Mute tab',
    '—',
    'Close',
    'Close other tabs',
    'Close tabs to the right',
  ]);
  for (const item of menu.querySelectorAll('[role=menuitem]')) {
    assert.equal((item as HTMLButtonElement).disabled, false, `${item.textContent} is enabled`);
    assert.equal(item.getAttribute('data-shortcut'), null);
    assert.ok(item.querySelector('svg'), `${item.textContent} has its icon`);
  }
  await click(byText(menu, 'New tab to the right'));
  await click(byText(menu, 'Duplicate'));
  await click(byText(menu, 'Copy URL'));
  await click(byText(menu, 'Open in external browser'));
  await click(byText(menu, 'Rename'));
  await click(byText(menu, 'Close other tabs'));
  await click(byText(menu, 'Close tabs to the right'));
  await click(byText(menu, 'Close'));
  assert.deepEqual(calls, [
    ['openBrowserTabAfter', 'b1'],
    ['duplicate', 'b1'],
    ['clipboard', 'https://docs.test/a'],
    ['toast', 'Copied URL'],
    ['openExternal', 'https://docs.test/a'],
    ['onRename'],
    ['closeOtherPaneTabs', 'b1', 'others'],
    ['closeOtherPaneTabs', 'b1', 'right'],
    ['closePaneTab', 'b1'],
  ]);
  await click(menu.querySelector('[data-menu-close]'));
  assert.equal(host.querySelector('[role=menu]'), null);
  await unmount();
});

test('a blank or duplicating browser tab offers no URL or audio items; Duplicate waits while one runs', async () => {
  store.reset({ paneTabs: [{ id: 'b2', kind: 'browser', duplicating: true }] });
  const { host, unmount } = await render(h(Strip, { id: 'b2', hasOthers: false, hasRight: false }));
  const menu = await openMenu(host);
  assert.deepEqual(layout(menu), [
    'New tab to the right',
    'Reload',
    'Duplicating…',
    '—',
    'Rename',
    '—',
    'Close',
    'Close other tabs',
    'Close tabs to the right',
  ]);
  assert.equal((byText(menu, 'Duplicating…') as HTMLButtonElement).disabled, true);
  assert.equal((byText(menu, 'Close other tabs') as HTMLButtonElement).disabled, true);
  assert.equal((byText(menu, 'Close tabs to the right') as HTMLButtonElement).disabled, true);
  // a page that is restoring a duplicate's history is busy too; a URL that is not a web page offers no URL items
  await act(async () => store.setState({ paneTabs: [{ id: 'b2', kind: 'browser', url: 'about:blank', restoring: true }] }));
  assert.equal((byText(menu, 'Duplicating…') as HTMLButtonElement).disabled, true);
  assert.equal(maybeText(menu, 'Copy URL'), null);
  // a copy still restoring its history takes no navigation, as its toolbar does not (#1508's reentrant restore)
  assert.equal((byText(menu, 'Reload') as HTMLButtonElement).disabled, true);
  await act(async () => store.setState({ paneTabs: [{ id: 'b2', kind: 'browser', url: 'https://a.test/', restoring: true }] }));
  assert.equal((byText(menu, 'Mute tab') as HTMLButtonElement).disabled, true);
  assert.equal((byText(menu, 'Copy URL') as HTMLButtonElement).disabled, false);
  await unmount();
});

test('every other tab kind gets the Close items only, enabled by what the strip shows', async () => {
  store.reset({ paneTabs: [{ id: 'changes', kind: 'changes' }] });
  const { host, unmount } = await render(h(Strip, { id: 'changes', hasOthers: true, hasRight: false }));
  const menu = await openMenu(host);
  assert.deepEqual(layout(menu), ['Close', 'Close other tabs', 'Close tabs to the right']);
  assert.equal((byText(menu, 'Close other tabs') as HTMLButtonElement).disabled, false);
  assert.equal((byText(menu, 'Close tabs to the right') as HTMLButtonElement).disabled, true);
  await unmount();
});

test('Reload and Mute reach the tab’s own page, whether or not it is in front, and say so when it has none', async () => {
  const { host, unmount } = await render(h(Strip, { id: 'b1' }));
  let menu = await openMenu(host);
  await click(byText(menu, 'Reload'));
  await click(byText(menu, 'Mute tab'));
  const notReady = ['toast', 'This browser page is not ready yet. Try again in a moment.', 'error'];
  assert.deepEqual(calls, [notReady, notReady]);
  calls.length = 0;
  const page = await render(h(Page, { id: 'b1' }));
  await click(byText(menu, 'Reload'));
  await click(byText(menu, 'Mute tab'));
  await flush();
  assert.deepEqual(calls, [['reload:page'], ['setAudioMuted', 7, true]]);
  // the tab records main's answer: the menu offers Unmute now
  assert.equal(store.getState().paneTabs[0].muted, true);
  assert.equal(store.getState().paneTabs[1].muted, undefined, 'only that tab');
  menu = host.querySelector('[role=menu]')!;
  assert.ok(byText(menu, 'Unmute tab').querySelector('svg'));
  // a failed unmute says so and leaves the tab muted
  calls.length = 0;
  muteAnswer = async () => {
    throw new Error('This browser page is no longer available.');
  };
  await click(byText(menu, 'Unmute tab'));
  await flush();
  assert.deepEqual(calls, [
    ['setAudioMuted', 7, false],
    ['toast', "Couldn't unmute this tab: This browser page is no longer available.", 'error'],
  ]);
  assert.equal(store.getState().paneTabs[0].muted, true);
  await page.unmount();
  await unmount();
});

test('a page without its id yet cannot mute: the menu says why', async () => {
  const page = await render(h(Page, { id: 'b1', pageId: null }));
  const { host, unmount } = await render(h(Strip, { id: 'b1' }));
  await click(byText(await openMenu(host), 'Mute tab'));
  await flush();
  assert.deepEqual(calls, [['toast', "Couldn't mute this tab: This browser page is not ready yet. Try again in a moment.", 'error']]);
  await unmount();
  await page.unmount();
});

test("the registry keeps the newest page of a tab: an older panel's unmount does not retire it", async () => {
  const older = await render(h(Page, { id: 'b1', tag: 'older' }));
  const newer = await render(h(Page, { id: 'b1', tag: 'newer' }));
  await older.unmount();
  browserTabPage('b1')!.reload();
  assert.deepEqual(calls, [['reload:newer']]);
  await newer.unmount();
  assert.equal(browserTabPage('b1'), null);
});

test('a page binding to a muted tab is muted too, and an unmuted tab leaves a new page alone', async () => {
  const unmuted = await render(h(Page, { id: 'b1' }));
  (Page as any).bound(9);
  assert.deepEqual(calls, []);
  await unmuted.unmount();
  const muted = await render(h(Page, { id: 'b1', muted: true }));
  (Page as any).bound(9);
  await flush();
  assert.deepEqual(calls, [['setAudioMuted', 9, true]]);
  assert.equal(store.getState().paneTabs[0].muted, true);
  // the new page could not be muted: the tab stops claiming it is
  muteAnswer = async () => {
    throw new Error('gone');
  };
  (Page as any).bound(10);
  await flush();
  assert.equal(store.getState().paneTabs[0].muted, false);
  await muted.unmount();
});

test('renaming in place: Enter or leaving keeps the name, Escape only drops it, and a click stays in the field', async () => {
  assert.equal(browserTabTitle({ id: 'x', kind: 'browser' }), 'New tab');
  assert.equal(browserTabTitle({ id: 'x', kind: 'browser', title: 'Page', customTitle: 'Mine' }), 'Mine');
  const field = async (tab: any) => {
    const r = await render(h('div', { onClick: log('tab click') }, h(PaneTabRename, { tab, onDone: log('done') })));
    return { ...r, input: r.host.querySelector('input')! };
  };
  let r = await field({ id: 'b1', kind: 'browser', title: 'Docs', customTitle: 'Mine' });
  assert.equal(r.input.value, 'Mine');
  assert.equal(r.input.placeholder, 'Docs');
  assert.equal(r.input.getAttribute('aria-label'), 'Tab name');
  assert.equal((globalThis as any).document.activeElement, r.input);
  await click(r.input);
  r.input.value = 'Reference';
  await press(r.input, 'Enter');
  assert.deepEqual(calls, [['renamePaneTab', 'b1', 'Reference'], ['done']]);
  await r.unmount();
  calls.length = 0;
  r = await field({ id: 'b1', kind: 'browser' });
  assert.equal(r.input.placeholder, 'New tab');
  r.input.value = 'Dropped';
  // Escape only cancels: the key is handled, so the app's own Escape does not also close the side pane
  const escape = new (globalThis as any).window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => r.input.dispatchEvent(escape));
  assert.equal(escape.defaultPrevented, true);
  assert.deepEqual(calls, [['done']]);
  await r.unmount();
});

test("an artifact tab's menu reloads its page, copies and opens its link, then the close items", async () => {
  const ART = { id: 'a1', kind: 'artifact', url: 'https://claude.ai/artifact/Ab3_xY9z', title: 'Landing page' };
  store.reset({ paneTabs: [ART] });
  const { host, unmount } = await render(h('div', null, h(Strip, { id: 'a1' }), h(Page, { id: 'a1', tag: 'artifact' })));
  const menu = await openMenu(host);
  assert.deepEqual(layout(menu), [
    'Reload',
    'Copy link',
    'Open in external browser',
    '—',
    'Close',
    'Close other tabs',
    'Close tabs to the right',
  ]);
  await click(byText(menu, 'Reload'));
  await click(byText(menu, 'Copy link'));
  await click(byText(menu, 'Open in external browser'));
  assert.deepEqual(calls, [['reload:artifact'], ['clipboard', ART.url], ['toast', 'Copied link'], ['openExternal', ART.url]]);
  await unmount();
  // a tab with no link has only the close items
  store.reset({ paneTabs: [{ id: 'a2', kind: 'artifact' }] });
  const bare = await render(h(Strip, { id: 'a2' }));
  assert.deepEqual(layout(await openMenu(bare.host)), ['Close', 'Close other tabs', 'Close tabs to the right']);
  await bare.unmount();
});
