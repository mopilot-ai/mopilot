// BrowserPanel with the store and the native bridge replaced by a recording fixture; the <webview>
// gets the guest API main would provide.
import { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { continueMessage } from '../../../shared/chromeHandoff.mjs';
import { window } from '../dom.ts';
import { installNativeStub } from '../ports/native.ts';
import { stubStore } from '../stubs.ts';

(globalThis as any).requestAnimationFrame = (fn: Function) => {
  fn();
  return 1;
};
export const fixture: any = {
  state: {},
  listeners: new Set<Function>(),
  callbacks: new Map<string, Function>(),
  calls: [],
  guest: null,
  changed() {
    for (const fn of fixture.listeners) fn();
  },
  subscribe(fn: Function) {
    fixture.listeners.add(fn);
    return () => fixture.listeners.delete(fn);
  },
  update(patch: any) {
    fixture.state = { ...fixture.state, ...patch };
    fixture.changed();
  },
  nativeCall(name: string, ...args: any[]) {
    fixture.calls.push([name, ...args]);
    return fixture.nativeHandlers[name](...args);
  },
  nativeHandlers: {},
};
mock.module('../../../src/store/browserDuplicate.ts', {
  namedExports: {
    browserDuplication: {
      bind: () => () => {},
      duplicate: async (id: string) => fixture.calls.push(['duplicate', id]),
      dismissError: (id: string) => fixture.calls.push(['dismissDuplicateError', id]),
    },
  },
});
const react = await import('react');
export const { act, createElement, useSyncExternalStore } = react;
const record =
  (name: string) =>
  (...a: unknown[]) => {
    fixture.calls.push([name, ...a]);
  };
stubStore({
  useStore: (s: (st: any) => any) => s(useSyncExternalStore(fixture.subscribe, () => fixture.state)),
  setState: (fn: (s: any) => any) => fixture.update(fn(fixture.state)),
  getState: () => fixture.state,
  setPrefs: (p: any) => fixture.update({ prefs: { ...fixture.state.prefs, ...p } }),
  closePaneTab: record('close'),
  closeOtherPaneTabs: record('closeOthers'),
  openBrowserTabAfter: record('openAfter'),
  renamePaneTab: record('rename'),
  openPaneTab: record('open'),
  openChanges: record('changes'),
  openSideChat: record('side'),
  navigate: record('navigate'),
  toast: record('toast'),
  toastFailure: (what: string) => (e: Error) => fixture.calls.push(['toast', `${what}: ${e.message}`, 'error']),
  sendMessage: (...a: unknown[]) => fixture.nativeCall('sendMessage', ...a),
  chatOf: (id: string) => (fixture.chatOf ? fixture.chatOf(id) : id),
});
const sub = (name: string) => (cb: Function) => {
  fixture.callbacks.set(name, cb);
  return () => fixture.callbacks.delete(name);
};
const browserCalls = [
  'preparePreview',
  'navigateGuest',
  'stopLoading',
  'chromeState',
  'pageState',
  'attach',
  'layer',
  'focusPopup',
  'closePopup',
  'cancelPasskey',
  'handoffRoute',
  'handoffContinuation',
  'continueInChrome',
  'cancelChromeHandoff',
  'takeOver',
  'stopAgent',
  'signinDone',
  'removeHistory',
  'answerDialog',
  'openAppLink',
  'dismissNotice',
  'stopPage',
  'reloadPage',
  'resubmitPage',
  'setAudioMuted',
];
installNativeStub({
  session: { removeQueued: (...args: unknown[]) => fixture.nativeCall('removeQueued', ...args) },
  availability: {
    onChanged: sub('availability'),
    chromeInstall: (...a: unknown[]) => fixture.nativeCall('chromeInstall', ...a),
  },
  browser: {
    ...Object.fromEntries(browserCalls.map((name) => [name, (...a: unknown[]) => fixture.nativeCall(name, ...a)])),
    onEvent: sub('event'),
    onShortcut: sub('shortcut'),
    onChannelChanged: sub('channel'),
    // pane tabs as main-owned views (shared.browser.viewTabs on)
    view: {
      ...Object.fromEntries(
        ['bind', 'bounds', 'nav', 'close'].map((name) => [name, (...a: unknown[]) => fixture.nativeCall(`view.${name}`, ...a)]),
      ),
      onEvent: sub('viewEvent'),
    },
    // a tab on a Host, seen by its frames
    remote: {
      ...Object.fromEntries(
        ['watch', 'view', 'stop', 'input'].map((name) => [name, (...a: unknown[]) => fixture.nativeCall(`remote.${name}`, ...a)]),
      ),
      onFrame: sub('remoteFrame'),
    },
  },
  // a port of a machine forwarded to this Mac
  host: { forwardPort: (...a: unknown[]) => fixture.nativeCall('host.forwardPort', ...a) },
  flags: { isEnabled: (key: string) => !!fixture.flags?.[key] },
  clipboard: {
    write: async (text: string) => {
      fixture.calls.push(['clipboard', text]);
    },
  },
  shell: { openExternal: (...a: unknown[]) => fixture.nativeCall('external', ...a) },
});
// The bookmark star and menu, the first-run import card and the suggestions hook have their own UI tests
// (tests/browserBookmarksUI.test.ts, tests/browserImportUI.test.ts); here they record what the panel gives them.
mock.module('../../../src/components/panels/BrowserBookmarks.tsx', {
  namedExports: {
    BookmarkStar: (p: any) => {
      fixture.star = p;
      return createElement('i', { className: 'star-stub' });
    },
    BookmarksMenu: (p: any) => {
      fixture.bookmarksMenu = p;
      return createElement('i', { className: 'bookmarks-stub' });
    },
  },
});
mock.module('../../../src/components/panels/BrowserLoginKey.tsx', {
  namedExports: {
    BrowserLoginKey: (p: any) => {
      fixture.loginKey = p;
      return createElement('i', { className: 'login-key-stub' });
    },
  },
});
mock.module('../../../src/components/panels/BrowserLoginOffer.tsx', {
  namedExports: {
    BrowserLoginOffer: (p: any) => {
      fixture.loginOffer = p;
      return createElement('i', { className: 'login-offer-stub' });
    },
  },
});
// the Downloads button, panel and peek have their own UI test (tests/browserDownloadsUI.test.ts)
mock.module('../../../src/components/panels/browserPanel/Downloads.tsx', {
  namedExports: {
    NOTICE_SLOT: 'browser-download-slot',
    BrowserDownloads: (p: any) => {
      fixture.downloads = p;
      return createElement('i', { className: 'downloads-stub' });
    },
  },
});
mock.module('../../../src/components/panels/BrowserImportCard.tsx', {
  namedExports: { BrowserImportCard: () => createElement('i', { className: 'import-card-stub' }) },
});
mock.module('../../../src/lib/browserSuggest.ts', {
  namedExports: {
    SUGGEST_DELAY_MS: 80,
    useSuggestions: (text: string, active: boolean) => {
      fixture.suggestArgs.push([text, active]);
      return fixture.suggest;
    },
  },
});
// Annotate mode's bar has its own UI test (tests/browserAnnotateUI.test.ts)
mock.module('../../../src/components/panels/BrowserAnnotate.tsx', {
  namedExports: {
    AnnotateBar: (p: any) => {
      fixture.annotate = p;
      return createElement('div', { className: 'annotate-stub' });
    },
  },
});
const { createRoot } = await import('react-dom/client');
const { BrowserPanel } = await import('../../../src/components/panels/BrowserPanel.tsx');
export let root: ReturnType<typeof createRoot>;
export let container: HTMLElement;
let props: any;
export const event = (kind: string, pageId = 10, extra: any = {}) => ({
  rootId: 10,
  pageId,
  kind,
  message: kind + ' notice',
  origin: 'https://task.test',
  ...extra,
});
function guestMethods(wv: any) {
  fixture.guest = wv;
  Object.assign(wv, {
    getWebContentsId: () => {
      if (fixture.guestError) throw new Error('not attached');
      return 10;
    },
    getURL: () => {
      if (fixture.syncError) throw new Error('gone');
      return fixture.guestUrl;
    },
    getTitle: () => fixture.title,
    canGoBack: () => fixture.back,
    canGoForward: () => fixture.forward,
    isLoading: () => fixture.loading,
    loadURL: (url: string) => {
      fixture.calls.push(['loadURL', url]);
      return fixture.loadURL(url);
    },
    reloadIgnoringCache: () => {
      if (fixture.reloadError) throw new Error('not ready');
      fixture.calls.push(['reloadIgnoringCache']);
    },
    reload: () => {
      fixture.calls.push(['reload']);
      if (fixture.reloadError) throw new Error('not ready');
    },
    stop: () => fixture.calls.push(['stop']),
    findInPage: (text: string, options: unknown) => fixture.calls.push(['find', text, options]),
    stopFindInPage: (action: string) => fixture.calls.push(['stopFind', action]),
    goBack: () => fixture.calls.push(['back']),
    goForward: () => fixture.calls.push(['forward']),
  });
}
const createOriginal = document.createElement.bind(document);
(document as any).createElement = (name: string, ...args: any[]) => {
  const el = createOriginal(name, ...(args as []));
  if (name === 'webview') guestMethods(el);
  return el;
};
export async function setup(options: any = {}) {
  fixture.state = {
    paneTabs: [{ id: 'tab', kind: 'browser', url: 'https://task.test/start', title: 'Task', agentChat: 'agent-chat', ...options.tab }],
    prefs: { browserFullUrl: false, ...options.prefs },
  };
  fixture.chatOf = options.chatOf;
  fixture.calls = [];
  fixture.suggestArgs = [];
  fixture.suggest = {
    items: [],
    index: -1,
    setIndex: (i: number) => fixture.calls.push(['hover', i]),
    move: (d: number) => fixture.calls.push(['move', d]),
    drop: (u: string) => fixture.calls.push(['drop', u]),
  };
  fixture.callbacks.clear();
  fixture.guestError = false;
  fixture.syncError = false;
  fixture.reloadError = false;
  fixture.guestUrl = 'https://task.test/start';
  fixture.title = 'Task';
  fixture.back = true;
  fixture.forward = true;
  fixture.loading = false;
  fixture.loadURL = async () => {};
  fixture.nativeHandlers = {
    preparePreview: async (_chat: string, url: string) => url,
    navigateGuest: async (_id: number, action: string, url?: string) => fixture.guest[action](url),
    chromeState: async () => ({ active: 'builtin' }),
    pageState: async () => ({ pages: [], restartUrl: 'https://task.test/start' }),
    attach: async () => {},
    focusPopup: async () => {},
    stopLoading: async () => {},
    closePopup: async () => {},
    cancelPasskey: async () => 1,
    handoffRoute: async () => 'your-chrome',
    handoffContinuation: async ({ chatId, url, signedIn }: any) => ({
      message: continueMessage(await fixture.nativeHandlers.handoffRoute(chatId), url, undefined, { signedIn }),
      precondition: { url, token: 'current' },
    }),
    continueInChrome: async () => ({ ok: true, url: 'https://task.test/start' }),
    external: async () => {},
    sendMessage: async () => {},
    takeOver: async () => true,
    stopAgent: async () => true,
    layer: async () => true,
    signinDone: async () => true,
    removeHistory: async () => {},
    'remote.watch': async () => true,
    'remote.view': async () => true,
    'remote.stop': async () => true,
    'remote.input': async () => true,
    'host.forwardPort': async () => ({ localPort: 41000 }),
    chromeInstall: async () => 'chrome',
    ...options.handlers,
  };
  if (options.guestError) fixture.guestError = true;
  props = { tabId: 'tab', cwd: '/project', threadId: 'thread', ...options.props };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(BrowserPanel, props)));
}
export async function emit(type: string, extra: any = {}) {
  await act(async () => fixture.guest.dispatchEvent(Object.assign(new window.Event(type), extra)));
}
export async function notice(e: any) {
  await act(async () => fixture.callbacks.get('event')?.(e));
}
export function button(label: string) {
  const el = [...container.querySelectorAll('button')].find(
    (el) => el.textContent === label || el.querySelector('span')?.textContent === label || el.getAttribute('aria-label') === label,
  );
  assert.ok(el, `button ${label} exists`);
  return el;
}
export async function click(label: string) {
  await act(async () => button(label).click());
}
/** Clicks a page notice's action (the toolbar has a Reload button of its own). */
/** Clicks a page notice's action, or its close button by what it does (the toolbar has a Reload button of its own). */
export async function noticeClick(label: string) {
  const el = [...container.querySelectorAll<HTMLButtonElement>('.browser-notice[role="alert"] button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  );
  assert.ok(el, `notice action ${label}`);
  await act(async () => el.click());
}
export async function change(selector: string, value: string) {
  const el = container.querySelector<HTMLInputElement>(selector)!;
  assert.ok(el);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
}
export async function submit(selector = '.browser-addr') {
  await act(async () =>
    container.querySelector(selector)!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as any),
  );
}
export async function rerender(p: any = {}) {
  props = { ...props, ...p };
  await act(async () => root.render(createElement(BrowserPanel, props)));
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null as any;
  container?.remove();
  fixture.guest = null;
});

export function clearRoot() {
  root = null as any;
}
export const input = () => container.querySelector<HTMLInputElement>('.browser-addr input')!;
export const tabState = (id = 'tab') => fixture.state.paneTabs.find((t: any) => t.id === id);

export { window };
