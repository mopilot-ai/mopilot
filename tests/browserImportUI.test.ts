// The pane's first-run offer (BrowserImportCard.tsx) and the imported-data lines in
// Settings → Browser (BrowserImportData.tsx), over a fake native bridge.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import * as React from 'react';
import { browserImportKit } from './support/browser-import-kit.ts';

const { act, createElement } = React;
const { f, defaults, store } = browserImportKit();
const { createRoot } = await import('react-dom/client');
const { BrowserImportCard, joinNames } = await import('../src/components/panels/BrowserImportCard.tsx');
const { BrowserImportData } = await import('../src/components/pages/settings/BrowserImportData.tsx');

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;
async function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(el));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  f.calls = [];
  f.handlers = defaults();
  f.progress.clear();
  f.flags = { 'shared.browser.import': true };
  store.reset({ prefs: { browserImportPrompt: 'pending', browserImportSnoozes: 0, browserImportSnoozeUntil: 0 } });
});
const tick = (ms = 5) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const click = (el: Element) => act(async () => void el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as any));
// a button by its words, or by what an icon button (the notice's close) does
const buttonByText = (text: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text || b.getAttribute('aria-label') === text,
  ) as HTMLButtonElement;
const calls = (name: string) => f.calls.filter((c: any[]) => c[0] === name).map((c: any[]) => c.slice(1));

const chrome = {
  id: 'chrome',
  name: 'Google Chrome',
  kind: 'chromium',
  status: 'ready',
  profiles: [
    { id: 'Default', name: 'Work', path: '/c/Default' },
    { id: 'Profile 1', name: 'Home', path: '/c/Profile 1' },
  ],
  kinds: { bookmarks: true, history: true, cookies: true, passwords: true },
};
const safari = {
  id: 'safari',
  name: 'Safari',
  kind: 'safari',
  status: 'needs_full_disk_access',
  profiles: [{ id: 'Safari', name: 'Safari', path: '/s' }],
  kinds: { bookmarks: true, history: true, cookies: true, passwords: false },
};
const brave = { ...chrome, id: 'brave', name: 'Brave', status: 'not_installed', profiles: [] };
const sys = { ...chrome, id: 'vivaldi', name: 'Vivaldi', status: 'unsupported', profiles: [] };

const emitProgress = (e: any) => act(async () => f.progress.forEach((cb: (e: any) => void) => cb(e)));

test('joinNames: one, two and more browsers read as a list', () => {
  assert.equal(joinNames([]), '');
  assert.equal(joinNames(['Chrome']), 'Chrome');
  assert.equal(joinNames(['Chrome', 'Safari']), 'Chrome and Safari');
  assert.equal(joinNames(['Chrome', 'Arc', 'Safari']), 'Chrome, Arc and Safari');
});

test('the first-run card: names the browsers that can be imported, opens the dialog, and goes away for now (1, 3, 7 days) or for good', async () => {
  f.handlers.sources = async () => [chrome, brave, safari];
  await render(createElement(BrowserImportCard));
  await tick();
  const card = () => container.querySelector('.browser-import-card');
  assert.match(card()!.textContent!, /from Google Chrome and Safari\./);
  const events: unknown[] = [];
  window.addEventListener('open-browser-import', (e: any) => {
    events.push(e.detail);
  });
  await click(buttonByText('Import…'));
  assert.deepEqual(events, [null]);
  const before = Date.now();
  // closing the card is Not now: Import is the one primary pill
  assert.equal(buttonByText('Import…').className, 'primary');
  assert.equal(container.querySelector('.browser-import-card .browser-notice-close')!.getAttribute('aria-label'), 'Not now');
  await click(buttonByText('Not now'));
  const [{ browserImportSnoozes, browserImportSnoozeUntil }] = calls('setPrefs')[0];
  assert.equal(browserImportSnoozes, 1);
  assert.ok(browserImportSnoozeUntil >= before + 86_400_000);
  assert.equal(card(), null, 'put off');
  // it returns once the time has passed, and "Don't show again" ends it
  await act(async () => store.set({ prefs: { ...store.get().prefs, browserImportSnoozeUntil: 0 } }));
  await tick();
  assert.ok(card());
  await click(buttonByText("Don't show again"));
  assert.deepEqual(calls('setPrefs').at(-1), [{ browserImportPrompt: 'dismissed' }]);
  assert.equal(card(), null);
});

test('the first-run card stays away when the switch is off, when nothing can be imported and when the question fails', async () => {
  f.handlers.sources = async () => [brave, sys];
  await render(createElement(BrowserImportCard));
  await tick();
  assert.equal(container.querySelector('.browser-import-card'), null);
  f.handlers.sources = async () => {
    throw new Error('main is busy');
  };
  await act(async () => store.set({ prefs: { ...store.get().prefs, browserImportSnoozeUntil: 1 } }));
  await tick();
  assert.equal(container.querySelector('.browser-import-card'), null);
  f.flags['shared.browser.import'] = false;
  f.handlers.sources = async () => [chrome];
  await act(async () => store.set({ prefs: { ...store.get().prefs, browserImportSnoozeUntil: 0 } }));
  await tick();
  assert.equal(container.querySelector('.browser-import-card'), null);
  // an answer that arrives after the card went away is ignored
  f.flags['shared.browser.import'] = true;
  let late: (v: any[]) => void = () => {};
  f.handlers.sources = () => new Promise((r) => (late = r));
  await act(async () => store.set({ prefs: { ...store.get().prefs, browserImportPrompt: 'pending', browserImportSnoozeUntil: 2 } }));
  await act(async () => store.set({ prefs: { ...store.get().prefs, browserImportPrompt: 'dismissed' } }));
  await act(async () => late([chrome]));
  assert.equal(container.querySelector('.browser-import-card'), null);
});

const imported = {
  history: [{ source: 'chrome', count: 412 }],
  bookmarks: [{ source: 'safari', count: 87 }],
  cookies: [
    { site: 'github.com', source: 'chrome', importedAt: 1, count: 1 },
    { site: 'news.test', source: 'custom', importedAt: 1, count: 4 },
  ],
  passwords: [],
  last: null,
};

test('imported data in Settings: what came in, per browser and site, each with a way to take it out', async () => {
  f.handlers.imported = async () => imported;
  f.handlers.deleteHistory = async () => 412;
  f.handlers.deleteBookmarks = async () => 87;
  f.handlers.removeCookies = async () => 1;
  await render(createElement(BrowserImportData));
  await tick();
  assert.deepEqual(
    [...container.querySelectorAll('.import-data-line span')].map((s) => s.textContent),
    [
      'Imported history from Chrome: 412 pages',
      'Imported bookmarks from Safari: 87',
      'Signed in to github.com from Chrome: 1 cookie',
      'Signed in to news.test from custom: 4 cookies',
      'All imported sign-ins',
    ],
  );
  await click(buttonByText('Delete'));
  assert.deepEqual(calls('deleteHistory'), [['chrome']]);
  await click([...container.querySelectorAll('button')].filter((b) => b.textContent === 'Delete')[1]);
  assert.deepEqual(calls('deleteBookmarks'), [['safari']]);
  await click([...container.querySelectorAll('button')].filter((b) => b.textContent === 'Remove')[1]);
  assert.deepEqual(calls('removeCookies'), [['news.test']]);
  // after each removal the lines are read again, and the user is told
  assert.deepEqual(
    calls('toast')
      .slice(0, 3)
      .map((t: any[]) => t[0]),
    ['Removed imported history', 'Removed imported bookmarks', 'Removed imported sign-in for news.test'],
  );
  assert.ok(calls('imported').length >= 4);
  // "Remove all" asks first
  (globalThis as any).confirm = () => false;
  await click(buttonByText('Remove all'));
  assert.equal(calls('removeCookies').length, 1);
  (globalThis as any).confirm = () => true;
  await click(buttonByText('Remove all'));
  assert.deepEqual(calls('removeCookies').at(-1), []);
  // a finished import refreshes the lines; a failed removal says so
  const reads = calls('imported').length;
  await emitProgress({ jobId: 'x', kind: 'history', result: { status: 'ok' } });
  assert.equal(calls('imported').length, reads + 1);
  f.handlers.deleteHistory = async () => {
    throw new Error('disk full');
  };
  await click(buttonByText('Delete'));
  assert.match(calls('toast').at(-1)[0], /Couldn't remove imported history: disk full/);
  assert.equal(calls('toast').at(-1)[1], 'error');
  // a single imported site has no "all" line; nothing imported shows nothing; a failed read shows nothing
  f.handlers.imported = async () => ({ ...imported, cookies: [imported.cookies[0]] });
  await emitProgress({});
  assert.equal(buttonByText('Remove all'), undefined);
  f.handlers.imported = async () => ({ history: [], bookmarks: [], cookies: [], passwords: [], last: null });
  await emitProgress({});
  assert.equal(container.querySelector('.import-data'), null);
  f.handlers.imported = async () => {
    throw new Error('main is busy');
  };
  await emitProgress({});
});

test('imported data is not shown when importing is switched off', async () => {
  f.flags['shared.browser.import'] = false;
  await render(createElement(BrowserImportData));
  assert.equal(container.innerHTML, '');
  assert.deepEqual(calls('imported'), []);
});

test('imported passwords are listed in Settings and can be deleted', async () => {
  f.handlers.imported = async () => ({ history: [], bookmarks: [], cookies: [], passwords: [{ source: 'chrome', count: 3 }], last: null });
  f.handlers.deletePasswords = async () => 3;
  await render(createElement(BrowserImportData));
  await tick();
  assert.deepEqual(
    [...container.querySelectorAll('.import-data-line span')].map((s) => s.textContent),
    ['Imported passwords from Chrome: 3'],
  );
  await click(buttonByText('Delete'));
  assert.deepEqual(calls('deletePasswords'), [['chrome']]);
  assert.equal(calls('toast')[0][0], 'Removed imported passwords');
});

test('refused cookie removal shows the failure and reloads the surviving sign-in for retry', async () => {
  let partial = false;
  f.handlers.imported = async () => ({ ...imported, cookies: partial ? [{ ...imported.cookies[0], count: 1 }] : imported.cookies });
  f.handlers.removeCookies = async () => {
    partial = true;
    throw new Error('1 imported cookie could not be removed. Try again.');
  };
  await render(createElement(BrowserImportData));
  await tick();
  await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!);
  await tick();
  assert.deepEqual(calls('toast').at(-1), [
    "Couldn't remove imported sign-in for github.com: 1 imported cookie could not be removed. Try again.",
    'error',
  ]);
  assert.equal([...container.querySelectorAll('.import-data-line span')].filter((s) => s.textContent?.startsWith('Signed in')).length, 1);
  assert.ok(container.textContent?.includes('Signed in to github.com from Chrome: 1 cookie'));
  assert.ok([...container.querySelectorAll('button')].some((b) => b.textContent === 'Remove'));
});

test('imported source labels treat Object.prototype names as unknown sources across every data category', async () => {
  f.handlers.imported = async () => ({
    history: [{ source: '__proto__', count: 1 }],
    bookmarks: [{ source: 'constructor', count: 1 }],
    passwords: [{ source: 'toString', count: 1 }],
    cookies: [{ source: 'hasOwnProperty', site: 'a.test', count: 1, importedAt: 1 }],
    last: null,
  });
  await render(createElement(BrowserImportData));
  await tick();
  const text = container.textContent ?? '';
  for (const source of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.ok(text.includes(source), source);
});
