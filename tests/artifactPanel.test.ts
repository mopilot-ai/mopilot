// The side pane's artifact tab (src/components/panels/ArtifactPanel.tsx): the page only while the built-in browser is
// signed in to claude.ai, else the wall with Sign in, Open in browser and Import; signing in here shows claude.ai's
// login and then the page; a page that lands on the login shows the wall; a newer version reloads; nothing navigates
// a page main hasn't bound yet.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, click, byText } from './support/pages-kit.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const calls: unknown[][] = [];
let viewTabs = true;
stubStore({
  closePaneTab: (id: string) => calls.push(['close', id]),
  toast: (...a: unknown[]) => calls.push(['toast', ...a]),
  setState: () => {},
});
mock.module('../src/lib/flags.ts', { namedExports: { isEnabled: () => viewTabs } });
mock.module('../src/session/open.ts', { namedExports: { openLink: (url: string) => calls.push(['open', url]) } });
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: (t: string) => calls.push(['copy', t]) } });
mock.module('../src/lib/ignored.ts', { namedExports: { noteIgnored: (what: string) => calls.push(['ignored', what]) } });

/** The page a mounted surface stands for: a fake <webview>-like handle the panel drives. */
class FakePage {
  url = '';
  id: number | null = null;
  fail = false;
  listeners = new Map<string, Set<() => void>>();
  addEventListener(t: string, fn: () => void) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: () => void) {
    this.listeners.get(t)?.delete(fn);
  }
  fire(t: string) {
    for (const fn of this.listeners.get(t) ?? []) fn();
  }
  getWebContentsId() {
    if (this.id == null) throw new Error('not bound');
    return this.id;
  }
  getURL() {
    return this.url;
  }
  loadURL(url: string) {
    calls.push(['load', url]);
    return this.fail ? Promise.reject(new Error('gone')) : Promise.resolve();
  }
  reload() {
    calls.push(['reload']);
  }
}
let page = new FakePage();
let surfaces: any[] = [];
mock.module('../src/components/panels/browserPanel/ViewSurface.tsx', {
  namedExports: {
    ViewSurface: (p: any) => {
      p.handleRef.current = page;
      surfaces.push(p);
      return h('div', { 'data-stub': 'ViewSurface', 'data-url': p.url, 'data-shown': String(p.shown) });
    },
  },
});
let shortcuts: any[] = [];
mock.module('../src/session/useBrowserShortcuts.ts', { namedExports: { useBrowserShortcuts: (o: any) => void shortcuts.push(o) } });
let downloads: any[] = [];
mock.module('../src/components/panels/browserPanel/Downloads.tsx', {
  namedExports: {
    NOTICE_SLOT: 'browser-download-slot',
    BrowserDownloads: (p: any) => (downloads.push(p), h('div', { 'data-stub': 'BrowserDownloads' })),
  },
});
const { ArtifactPanel, atClaudeLogin } = await import('../src/components/panels/ArtifactPanel.tsx');
const { browserTabPage } = await import('../src/session/browserTabPage.ts');

const URL = 'https://claude.ai/code/artifact/0a21f3e3-1b2c-4d5e-8f90-123456789abc';
const TAB = { id: 'art-1', kind: 'artifact', url: URL, title: 'Landing page', artifactKind: 'artifact', version: '1', ownerChat: 'c1' };
beforeEach(() => {
  calls.length = 0;
  viewTabs = true;
  page = new FakePage();
  surfaces = [];
  shortcuts = [];
  downloads = [];
});
const view = (v: any) => v.host.querySelector('[data-stub="ViewSurface"]') as HTMLElement | null;
const wall = (v: any) => v.host.querySelector('.artifact-wall');
const panel = (o: any = {}) =>
  h(ArtifactPanel, { tab: { ...TAB, ...o.tab } as any, shown: o.shown ?? true, signedIn: 'signedIn' in o ? o.signedIn : true });
const settle = () => act(async () => {});

test('signed in, the page shows in the shared profile, with its bar; Copy link and Open in browser act on its link', async () => {
  const v = await render(panel());
  assert.ok(view(v));
  assert.equal(view(v)!.dataset.url, URL);
  const s = surfaces.at(-1);
  assert.deepEqual([s.partition, s.paneId, s.chat, s.chatId, s.shown], ['persist:browser', 'art-1', 'c1', null, true]);
  assert.equal(v.host.querySelector('.artifact-pane-title')?.textContent, 'Landing page');
  assert.equal(v.host.querySelector('.artifact-pane-chip')?.textContent, 'Artifact · version 1');
  await click(v.host.querySelector('[aria-label="Copy link"]')!);
  await click(v.host.querySelector('[aria-label="Open in browser"]')!);
  // main closing the page closes the tab
  s.onClosed();
  assert.deepEqual(calls, [
    ['copy', URL],
    ['open', URL],
    ['close', 'art-1'],
  ]);
  await v.unmount();
});

test('signed out or unknown, the wall: Sign in and Open in browser; with no view tabs only Open', async () => {
  for (const signedIn of [false, null]) {
    const v = await render(panel({ signedIn, tab: { artifactKind: 'design', version: undefined } }));
    assert.equal(view(v), null);
    assert.match(wall(v)!.textContent!, /Sign in to claude.ai to see this design here/);
    assert.equal(v.host.querySelector('.artifact-pane-chip')?.textContent, 'Claude Design');
    assert.equal(v.host.querySelector('[aria-label="Reload"]'), null, 'nothing to reload');
    await click(byText(v.host, 'Open in browser'));
    assert.match(wall(v)!.textContent!, /Settings → Browser/);
    await v.unmount();
  }
  assert.deepEqual(calls, [
    ['open', URL],
    ['open', URL],
  ]);
  viewTabs = false;
  const v = await render(panel());
  assert.equal(view(v), null, 'no view to show it in');
  assert.match(wall(v)!.textContent!, /Open it in your browser/);
  assert.equal(v.host.querySelector('button.btn-pill:not(.soft)'), null, 'no Sign in');
  await v.unmount();
});

test("signing in here shows claude.ai's login, then the page once the login is left, until the profile says signed out", async () => {
  const v = await render(panel({ signedIn: null, tab: { url: undefined } }));
  assert.match(wall(v)!.textContent!, /this page here/);
  await v.rerender(panel({ signedIn: null }));
  await click(byText(v.host, 'Sign in to claude.ai'));
  assert.equal(view(v)!.dataset.url, 'https://claude.ai/login');
  // a new page loads the login itself; once bound it is left alone while it is there
  page.url = 'https://claude.ai/login';
  page.id = 3;
  page.fire('did-attach');
  page.fire('did-navigate-in-page');
  assert.ok(view(v));
  // Continue with Google: the identity provider's page is still signing in, nothing loads over it
  page.url = 'https://accounts.google.com/o/oauth2/auth?x=1';
  await act(async () => page.fire('did-navigate'));
  assert.deepEqual(calls, []);
  assert.equal(view(v)!.dataset.url, 'https://claude.ai/login');
  // the user signed in: claude.ai moved on, and the panel loads the page though the profile hasn't reported it yet
  page.url = 'https://claude.ai/new';
  await act(async () => page.fire('did-navigate'));
  await settle();
  assert.deepEqual(calls, [['load', URL]]);
  assert.ok(view(v));
  assert.equal(view(v)!.dataset.url, URL);
  // the profile then reports signed out: the wall again
  await v.rerender(panel({ signedIn: false }));
  assert.ok(wall(v));
  await v.unmount();
});

test('a page that lands on the login shows the wall until a sign-in is reported, then the page again', async () => {
  const v = await render(panel());
  page.id = 1;
  page.url = 'https://claude.ai/login?returnTo=x';
  await act(async () => page.fire('did-navigate'));
  assert.ok(wall(v), 'the profile is signed out after all');
  // the report flips to signed in (a sign-in elsewhere, an import): the page shows and goes back to the artifact
  await v.rerender(panel({ signedIn: false }));
  await v.rerender(panel({ signedIn: true }));
  assert.ok(view(v));
  await act(async () => page.fire('did-attach'));
  assert.deepEqual(
    calls.filter(([c]) => c === 'load'),
    [['load', URL]],
  );
  // a page at the artifact already, linked another way, is left alone; a navigation with no address is ignored
  calls.length = 0;
  page.url = `${URL}?v=2`;
  page.fire('did-navigate');
  page.url = '';
  page.fire('did-navigate');
  assert.deepEqual(calls, []);
  await v.unmount();
});

test('a newer version reloads a bound page; Reload and the tab menu reload only a bound page', async () => {
  const v = await render(panel());
  await click(v.host.querySelector('[aria-label="Reload"]')!);
  browserTabPage('art-1')!.reload();
  assert.deepEqual(calls, [], 'not bound yet');
  page.id = 2;
  await v.rerender(panel({ tab: { version: '2' } }));
  await click(v.host.querySelector('[aria-label="Reload"]')!);
  browserTabPage('art-1')!.reload();
  await v.rerender(panel({ tab: { version: '2' } }));
  assert.deepEqual(calls, [['reload'], ['reload'], ['reload']]);
  await v.unmount();
});

test("a load that fails is noted; the login check reads claude.ai's own login only", async () => {
  page.fail = true;
  const v = await render(panel({ signedIn: false }));
  await click(byText(v.host, 'Sign in to claude.ai'));
  page.id = 4;
  page.url = URL;
  await act(async () => page.fire('did-attach'));
  await settle();
  assert.deepEqual(calls, [
    ['load', 'https://claude.ai/login'],
    ['ignored', "load an artifact tab's page"],
  ]);
  await v.unmount();
  assert.equal(atClaudeLogin('https://claude.ai/login'), true);
  assert.equal(atClaudeLogin('https://claude.ai/login/sso'), true);
  assert.equal(atClaudeLogin('https://claude.ai/loginx'), false);
  assert.equal(atClaudeLogin('https://example.com/login'), false);
  assert.equal(atClaudeLogin('nope'), false);
});

test('a tab with no kind is a page; a page elsewhere is sent back to the artifact; the tab menu cannot mute it', async () => {
  const v = await render(panel({ tab: { artifactKind: undefined, ownerChat: undefined, url: 'https://claude.ai/artifact/Ab3_xY9z' } }));
  assert.equal(surfaces.at(-1).chat, null, 'a tab no chat owns');
  assert.match(v.host.querySelector('.artifact-pane-chip')!.textContent!, /^Artifact/);
  page.id = 5;
  page.url = 'https://example.com/elsewhere';
  await act(async () => page.fire('did-attach'));
  assert.deepEqual(calls, [['load', 'https://claude.ai/artifact/Ab3_xY9z']]);
  // a page at the artifact already, however it is linked, is left alone
  page.url = 'https://claude.ai/artifact/Ab3_xY9z?v=2';
  await act(async () => page.fire('did-attach'));
  assert.equal(calls.length, 1);
  await assert.rejects(browserTabPage('art-1')!.setMuted(true), /not ready/);
  await v.unmount();
});

test('a tab whose link is not a claude.ai page (an old tab) still loads what it names', async () => {
  const v = await render(panel({ tab: { url: 'https://example.com/x' } }));
  page.id = 6;
  page.url = 'https://claude.ai/new';
  await act(async () => page.fire('did-attach'));
  assert.deepEqual(calls, [['load', 'https://example.com/x']]);
  await v.unmount();
});

test("the page takes the browser pane's shortcuts (zoom, reload) while it shows in front (#2600)", async () => {
  const v = await render(panel());
  const o = shortcuts.at(-1);
  assert.equal(o.page.current, page, 'the page the pane shows');
  assert.equal(o.paneId, 'art-1');
  assert.equal(o.url, URL);
  assert.equal(o.front, true);
  assert.equal(o.address.current, null, 'no address bar to focus');
  // Reload reloads a bound page only; annotate does nothing here
  o.reload();
  page.id = 8;
  o.reload();
  o.annotate();
  assert.deepEqual(calls, [['reload']]);
  // a page not ready yet says so
  o.unavailable();
  assert.deepEqual(calls.at(-1), ['toast', 'This page is not ready yet. Try again in a moment.', 'error']);
  // ⌘F finds in the page (browserPanel/FindBar.tsx); a page with no find of its own says so, and the bar stays closed
  await act(async () => o.find('open'));
  assert.deepEqual(calls.at(-1), ['toast', "Find isn't available on this page", 'error']);
  assert.equal(v.host.querySelector('.browser-find'), null);
  await v.rerender(panel({ shown: false }));
  assert.equal(shortcuts.at(-1).front, false, 'behind another tab');
  await v.unmount();
  // the wall: no page, so nothing takes the keys
  const w = await render(panel({ signedIn: false }));
  assert.equal(shortcuts.at(-1).front, false);
  await w.unmount();
});

test("the page's downloads: the Downloads button in the bar and the notice slot above the page, told of only while shown (#2595)", async () => {
  const v = await render(panel());
  const bar = v.host.querySelector('.artifact-pane-bar')!;
  assert.ok(bar.querySelector('[data-stub="BrowserDownloads"]'), 'the button sits in the bar');
  const slot = v.host.querySelector('.artifact-pane > .browser-download-slot');
  assert.ok(slot, 'a slot under the bar');
  assert.equal(slot!.nextElementSibling?.className, 'browser-stage', 'above the page');
  assert.equal(downloads.at(-1).front, true);
  // the page's id once main bound it, none before
  assert.deepEqual(downloads.at(-1).pages(), []);
  page.id = 7;
  assert.deepEqual(downloads.at(-1).pages(), [7]);
  await v.rerender(panel({ shown: false }));
  assert.equal(downloads.at(-1).front, false, 'behind another tab: no notice');
  await v.unmount();
  // the wall has no page to download from
  const w = await render(panel({ signedIn: false }));
  assert.equal(w.host.querySelector('[data-stub="BrowserDownloads"]'), null);
  assert.equal(w.host.querySelector('.browser-download-slot'), null);
  await w.unmount();
});
