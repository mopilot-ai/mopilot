// The "Import from your browser" dialog (BrowserImportDialog.tsx), laid out as Codex's: the profile picker, the category switches,
// progress and results in each row, Retry for what failed, closing and the Full Disk Access path, over a fake native bridge.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import * as React from 'react';
import { browserImportKit } from './support/browser-import-kit.ts';

const { act, createElement } = React;
const { f, defaults, store } = browserImportKit({ passwordFiles: true });
const { createRoot } = await import('react-dom/client');
const { BrowserImportDialog } = await import('../src/components/dialogs/BrowserImportDialog.tsx');
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
const buttonByText = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;
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
  passwordFile: false,
};
const arc = {
  ...chrome,
  id: 'arc',
  name: 'Arc',
  profiles: [{ id: 'Default', name: 'Me', path: '/a' }],
  kinds: { ...chrome.kinds, bookmarks: false },
};
const safari = {
  id: 'safari',
  name: 'Safari',
  kind: 'safari',
  status: 'needs_full_disk_access',
  profiles: [{ id: 'Safari', name: 'Safari', path: '/s' }],
  kinds: { bookmarks: true, history: true, cookies: true, passwords: true },
  passwordFile: true,
};
const brave = { ...chrome, id: 'brave', name: 'Brave', status: 'not_installed', profiles: [] };
const sites = [{ site: 'github.com' }, { site: 'chase.com' }];

async function open(sourceList: any[] = [chrome, arc, safari, brave], detail: string | null = null) {
  f.handlers.sources = async () => sourceList;
  await render(createElement(BrowserImportDialog));
  assert.equal(container.querySelector('.import-dialog'), null, 'closed until asked');
  await act(async () => void window.dispatchEvent(new window.CustomEvent('open-browser-import', { detail } as any) as any));
  await tick();
}
const text = (sel: string) => container.querySelector(sel)?.textContent ?? null;
const rows = () => [...container.querySelectorAll('.import-row')];
const rowNames = () => rows().map((r) => r.querySelector('.import-name')!.textContent);
const toggle = (label: string) => container.querySelector(`[role=switch][aria-label="${label}"]`) as HTMLButtonElement;
const select = () => container.querySelector('select[aria-label=From]') as HTMLSelectElement;
async function pick(value: string) {
  await act(async () => {
    select().value = value;
    select().dispatchEvent(new window.Event('change', { bubbles: true }) as any);
  });
}
const emitProgress = (e: any) => act(async () => f.progress.forEach((cb: (e: any) => void) => cb(e)));
const results = () => rows().map((r) => r.querySelector('.import-result')?.textContent?.trim() ?? null);

test('the dialog: every readable profile in From, the first ready one chosen, a switch per category it can bring', async () => {
  await open();
  assert.equal(text('#import-title'), 'Import from your browser');
  assert.equal(text('.import-subtitle'), 'Choose data to bring over to the built-in browser');
  assert.deepEqual(
    [...select().options].map((o) => [o.value, o.textContent]),
    [
      ['chrome/Default', 'Google Chrome · Work'],
      ['chrome/Profile 1', 'Google Chrome · Home'],
      ['arc/Default', 'Arc · Me'],
      ['safari/Safari', 'Safari (needs Full Disk Access)'],
    ],
  );
  assert.equal(select().value, 'chrome/Default');
  assert.match(container.textContent!, /Close Google Chrome completely before importing/);
  assert.deepEqual(rowNames(), ['Saved passwords', 'Cookies', 'Browsing history', 'Bookmarks']);
  assert.deepEqual(
    rowNames().map((n) => toggle(n!).getAttribute('aria-checked')),
    ['true', 'true', 'true', 'true'],
  );
  assert.match(container.textContent!, /Your Mac will ask to allow access to "Google Chrome Safe Storage"/);
  // Arc keeps its bookmarks elsewhere: no row for them
  await pick('arc/Default');
  assert.deepEqual(rowNames(), ['Saved passwords', 'Cookies', 'Browsing history']);
  // without cookies and passwords the Mac does not ask; with nothing on, Import is off
  await click(toggle('Cookies'));
  assert.match(container.textContent!, /Safe Storage/);
  await click(toggle('Saved passwords'));
  assert.doesNotMatch(container.textContent!, /Safe Storage/);
  assert.equal(toggle('Cookies').getAttribute('aria-checked'), 'false');
  await click(toggle('Browsing history'));
  assert.equal(buttonByText('Import').disabled, true);
});

test('the dialog opens on the browser the caller names; without browsers it says so; a failed list is an empty one', async () => {
  await open([chrome, arc], 'arc');
  assert.equal(select().value, 'arc/Default');
  await click(buttonByText('Cancel'));
  assert.equal(container.querySelector('.import-dialog'), null);
  await open([brave]);
  assert.match(container.textContent!, /No browsers to import from were found on this Mac/);
  assert.equal(buttonByText('Import').disabled, true);
  let fail: (e: Error) => void = () => {};
  f.handlers.sources = () => new Promise((_r, reject) => (fail = reject));
  await act(async () => void window.dispatchEvent(new window.CustomEvent('open-browser-import', { detail: null } as any) as any));
  assert.match(container.textContent!, /Loading profiles…/);
  await act(async () => fail(new Error('main is busy')));
  await tick();
  assert.match(container.textContent!, /No browsers to import from/);
});

test('Import unlocks the key, imports every site as Codex does, shows each row as it finishes, and retires the first-run offer', async () => {
  await open([chrome]);
  await pick('chrome/Profile 1');
  let finish: (v: any) => void = () => {};
  f.handlers.start = async () => ({ ok: true, jobId: 'j1', sites, failed: {} });
  f.handlers.run = () => new Promise((r) => (finish = r));
  await click(buttonByText('Import'));
  assert.deepEqual(calls('start'), [
    [{ source: 'chrome', profile: 'Profile 1', kinds: { bookmarks: true, history: true, cookies: true, passwords: true } }],
  ]);
  assert.deepEqual(calls('run'), [[{ jobId: 'j1', sites: ['github.com', 'chase.com'] }]]);
  // bookmarks run first; progress for another job is ignored
  assert.equal(text('.import-subtitle'), 'Importing bookmarks…');
  assert.equal(buttonByText('Import').disabled, true);
  assert.equal(select().disabled, true);
  assert.equal(container.querySelectorAll('.import-spin').length, 4);
  await emitProgress({ jobId: 'other', kind: 'bookmarks', result: { status: 'failed' } });
  await emitProgress({ jobId: 'j1', kind: 'bookmarks', result: { status: 'ok', imported: 1 } });
  assert.equal(text('.import-subtitle'), 'Importing browsing history…');
  await emitProgress({ jobId: 'j1', kind: 'history', result: { status: 'ok', imported: 2 } });
  assert.equal(text('.import-subtitle'), 'Importing cookies…');
  await emitProgress({ jobId: 'j1', kind: 'cookies', result: { status: 'ok', imported: 2 } });
  assert.equal(text('.import-subtitle'), 'Importing saved passwords…');
  // every row reported, the run not yet answered
  await emitProgress({ jobId: 'j1', kind: 'passwords', result: { status: 'ok', imported: 3 } });
  assert.equal(text('.import-subtitle'), 'Importing…');
  // a click outside does nothing while it runs
  await act(
    async () =>
      void container.querySelector('.sketch-backdrop')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any),
  );
  assert.ok(container.querySelector('.import-dialog'));
  await act(async () =>
    finish({
      ok: true,
      results: {
        bookmarks: { status: 'ok', imported: 87, skippedExisting: 2 },
        history: { status: 'ok', imported: 1 },
        cookies: { status: 'ok', imported: 23, failed: 1, sites: 2 },
        passwords: { status: 'ok', imported: 3, replaced: 1, sites: 2 },
      },
    }),
  );
  assert.equal(text('#import-title'), 'Import complete');
  assert.equal(text('.import-subtitle'), 'Your data is now available in the built-in browser');
  assert.deepEqual(results(), ['3 passwords (1 updated)', '23 cookies (1 refused)', '1 page', '87 bookmarks (2 already here)']);
  assert.deepEqual(calls('setPrefs'), [[{ browserImportPrompt: 'done' }]]);
  assert.equal(buttonByText('Retry'), undefined);
  await click(buttonByText('Done'));
  assert.equal(container.querySelector('.import-dialog'), null);
  assert.equal(calls('cancel').length, 0, 'a finished job needs no cancelling');
});

test('only the categories switched on are asked for, the rest keep their switch; nothing new keeps the offer', async () => {
  await open([chrome]);
  await click(toggle('Cookies'));
  await click(toggle('Saved passwords'));
  f.handlers.start = async () => ({ ok: true, jobId: 'j2', sites: [], failed: {} });
  f.handlers.run = async () => ({
    ok: true,
    results: { bookmarks: { status: 'ok', imported: 0, skippedExisting: 4 }, history: { status: 'ok' } },
  });
  await click(buttonByText('Import'));
  await tick();
  assert.deepEqual(calls('start')[0][0].kinds, { bookmarks: true, history: true, cookies: false, passwords: false });
  assert.equal(text('.import-subtitle'), 'No browser data was available to import');
  assert.deepEqual(results(), [null, null, '0 pages', '0 bookmarks (4 already here)']);
  assert.equal(toggle('Cookies').disabled, true);
  assert.deepEqual(calls('setPrefs'), []);
});

test('failures: a start or run refused says why on the first screen; failed rows say why, and Retry runs only them', async () => {
  await open([chrome]);
  f.handlers.start = async () => ({ ok: false, code: 'keychain_denied', message: 'no' });
  await click(buttonByText('Import'));
  assert.match(text('.import-error')!, /sign-in key.*choose Allow/);
  assert.equal(buttonByText('Import').disabled, false);
  f.handlers.start = async () => ({ ok: true, jobId: 'j3', sites, failed: {} });
  f.handlers.run = async () => ({ ok: false, code: 'cancelled', message: 'gone' });
  await click(buttonByText('Import'));
  await tick();
  assert.match(text('.import-error')!, /cancelled/);
  f.handlers.run = async () => ({
    ok: true,
    results: {
      bookmarks: { status: 'ok', imported: 3 },
      history: { status: 'failed', code: 'read_failed' },
      cookies: { status: 'failed', code: 'keychain_denied' },
      passwords: { status: 'cancelled' },
    },
  });
  await click(buttonByText('Import'));
  await tick();
  assert.equal(text('#import-title'), 'Import complete');
  assert.deepEqual(
    [...container.querySelectorAll('.import-row .import-error')].map((e) => e.textContent),
    [
      'The import was cancelled.',
      "Your Mac didn't let MoPilot read Google Chrome's sign-in key. Try again and choose Allow.",
      "Couldn't read Google Chrome's history. Quit Google Chrome and try again.",
    ],
  );
  assert.deepEqual(results(), ['Cancelled', 'Failed', 'Failed', '3 bookmarks']);
  // retry: only the three that did not finish; the bookmarks result stays
  f.handlers.start = async () => ({ ok: true, jobId: 'j4', sites, failed: {} });
  f.handlers.run = async () => ({
    ok: true,
    results: {
      history: { status: 'failed' },
      cookies: { status: 'failed', code: 'missing' },
      passwords: { status: 'failed', code: 'storage_unavailable' },
    },
  });
  await click(buttonByText('Retry'));
  await tick();
  assert.deepEqual(calls('start').at(-1)[0].kinds, { bookmarks: false, history: true, cookies: true, passwords: true });
  assert.deepEqual(results(), ['Failed', 'Failed', 'Failed', '3 bookmarks']);
  assert.match(container.textContent!, /can't encrypt saved passwords/);
  // everything failing: the import failed
  f.handlers.start = async () => ({ ok: true, jobId: 'j5', sites, failed: {} });
  f.handlers.run = async () => ({ ok: true, results: { history: { status: 'failed', code: 'busy' } } });
  await click(buttonByText('Retry'));
  await tick();
  assert.equal(results()[3], '3 bookmarks');
  await click(buttonByText('Done'));
  await open([chrome]);
  await click(toggle('Bookmarks'));
  f.handlers.run = async () => ({
    ok: true,
    results: { history: { status: 'failed' }, cookies: { status: 'failed' }, passwords: { status: 'failed' } },
  });
  await click(buttonByText('Import'));
  await tick();
  assert.equal(text('#import-title'), 'Import failed');
  assert.equal(text('.import-subtitle'), 'We were unable to import your browsing data');
});

test('closing: Escape and the X cancel a running import; a start that answers after closing is cancelled; a click outside closes when idle', async () => {
  await open([chrome]);
  let answer: (v: any) => void = () => {};
  f.handlers.start = () => new Promise((r) => (answer = r));
  await click(buttonByText('Import'));
  await act(async () => void window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }) as any));
  assert.ok(container.querySelector('.import-dialog'), 'another key does nothing');
  await act(async () => void window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }) as any));
  assert.equal(container.querySelector('.import-dialog'), null);
  await act(async () => answer({ ok: true, jobId: 'late', sites, failed: {} }));
  assert.deepEqual(calls('cancel'), [['late']]);
  // a failed late start is ignored, and a failing cancel is only noted
  f.handlers.cancel = async () => {
    throw new Error('gone');
  };
  await open([chrome]);
  await click(buttonByText('Import'));
  await click(container.querySelector('button[aria-label=Close]')!);
  await act(async () => answer({ ok: false, code: 'busy', message: 'x' }));
  assert.equal(container.querySelector('.import-dialog'), null);
  await open([chrome]);
  await click(buttonByText('Import'));
  await click(container.querySelector('button[aria-label=Close]')!);
  await act(async () => answer({ ok: true, jobId: 'late2', sites, failed: {} }));
  // closing while it writes cancels the job, and its late result changes nothing
  f.handlers.cancel = async () => true;
  let finish: (v: any) => void = () => {};
  f.handlers.start = async () => ({ ok: true, jobId: 'j6', sites, failed: {} });
  f.handlers.run = () => new Promise((r) => (finish = r));
  await open([chrome]);
  await click(buttonByText('Import'));
  await click(container.querySelector('button[aria-label=Close]')!);
  assert.deepEqual(calls('cancel').at(-1), ['j6']);
  await act(async () => finish({ ok: true, results: { history: { status: 'ok', imported: 5 } } }));
  assert.deepEqual(calls('setPrefs'), []);
  // idle: a click outside closes, a press inside does not
  await open([chrome]);
  await act(
    async () => void container.querySelector('.import-dialog')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any),
  );
  assert.ok(container.querySelector('.import-dialog'));
  await act(
    async () =>
      void container.querySelector('.sketch-backdrop')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any),
  );
  assert.equal(container.querySelector('.import-dialog'), null);
});

test('a second click while the import waits does not start another', async () => {
  await open([chrome]);
  let answer: (v: any) => void = () => {};
  f.handlers.start = () => new Promise((r) => (answer = r));
  const go = buttonByText('Import');
  await act(async () => {
    go.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as any);
    go.dispatchEvent(new window.MouseEvent('click', { bubbles: true }) as any);
  });
  assert.equal(calls('start').length, 1);
  await act(async () => answer({ ok: false, code: 'busy', message: '' }));
});

test('Safari without Full Disk Access: explains, opens System Settings, and checks again; an old list never replaces a newer one', async () => {
  await open([safari]);
  assert.match(text('.import-note')!, /Safari's files are protected/);
  // only the passwords file can be imported without Full Disk Access, and it starts off
  assert.deepEqual(rowNames(), ['Saved passwords']);
  assert.equal(toggle('Saved passwords').getAttribute('aria-checked'), 'false');
  assert.equal(buttonByText('Import').disabled, true);
  await click(buttonByText('Open Settings'));
  assert.deepEqual(calls('openFullDiskAccess'), [[]]);
  f.handlers.openFullDiskAccess = async () => {
    throw new Error('no');
  };
  await click(buttonByText('Open Settings'));
  // a switch already on yet still refused belongs to an older copy of the app: only Check again says so
  assert.doesNotMatch(text('.import-note')!, /Already on/);
  await click(buttonByText('Check again'));
  await tick();
  assert.match(
    text('.import-note')!,
    /Already on\? .*older copy of MoPilot.*remove it with −, add it again with \+, then quit and reopen MoPilot\./,
  );
  f.handlers.sources = async () => [{ ...safari, status: 'ready' }];
  await click(buttonByText('Check again'));
  await tick();
  assert.equal(container.querySelector('.import-note'), null);
  assert.deepEqual(rowNames(), ['Saved passwords', 'Cookies', 'Browsing history', 'Bookmarks']);
  assert.deepEqual(
    rowNames().map((n) => toggle(n!).getAttribute('aria-checked')),
    ['false', 'true', 'true', 'true'],
    'passwords from a file the user first exports start off',
  );
  assert.doesNotMatch(container.textContent!, /Safe Storage/);
  let late: (v: any[]) => void = () => {};
  f.handlers.sources = () => new Promise((r) => (late = r));
  await act(async () => void window.dispatchEvent(new window.CustomEvent('open-browser-import', { detail: null } as any) as any));
  f.handlers.sources = async () => [chrome];
  await act(async () => void window.dispatchEvent(new window.CustomEvent('open-browser-import', { detail: null } as any) as any));
  await tick();
  await act(async () => late([safari]));
  assert.equal(select().value, 'chrome/Default');
  await open([safari]);
  assert.doesNotMatch(text('.import-note')!, /Already on/, 'a newly opened dialog has not checked again yet');
});

test("Safari's passwords: export from Safari, choose the file (Import waits for it), import, then send the file to the Trash", async () => {
  await open([{ ...safari, status: 'ready' }]);
  assert.equal(container.querySelector('.import-note'), null);
  await click(toggle('Saved passwords'));
  assert.match(text('.import-note')!, /Safari keeps passwords in iCloud Keychain.*File → Export → Passwords…/);
  assert.equal(buttonByText('Import').disabled, true, 'no file yet');
  // a cancelled panel, or one that fails, chooses nothing
  f.handlers.choosePasswordFile = async () => null;
  await click(buttonByText('Choose file…'));
  f.handlers.choosePasswordFile = async () => {
    throw new Error('ipc');
  };
  await click(buttonByText('Choose file…'));
  assert.equal(buttonByText('Import').disabled, true);
  f.handlers.choosePasswordFile = async () => ({ name: 'Passwords.csv' });
  await click(buttonByText('Choose file…'));
  assert.match(text('.import-file')!, /Passwords\.csv/);
  assert.ok(buttonByText('Choose another file…'));
  assert.doesNotMatch(container.textContent!, /Safe Storage/, 'no keychain prompt for a file');
  // without passwords the file isn't needed
  await click(toggle('Saved passwords'));
  assert.equal(container.querySelector('.import-file'), null);
  await click(toggle('Saved passwords'));
  f.handlers.start = async () => ({ ok: true, jobId: 'j1', sites, failed: {} });
  f.handlers.run = async () => ({ ok: true, results: { passwords: { status: 'ok', imported: 12, sites: 9 } } });
  await click(toggle('Cookies'));
  await click(toggle('Browsing history'));
  await click(toggle('Bookmarks'));
  await click(buttonByText('Import'));
  await tick();
  assert.deepEqual(calls('start')[0][0].kinds, { bookmarks: false, history: false, cookies: false, passwords: true });
  assert.match(text('.import-note')!, /Passwords\.csv still holds your passwords in plain text/);
  // the Trash refusing says so; then it works
  f.handlers.trashPasswordFile = async () => ({ ok: false, code: 'read_failed', message: '' });
  await click(buttonByText('Move to Trash'));
  assert.match(text('.import-error')!, /Couldn't move the passwords file to the Trash/);
  f.handlers.trashPasswordFile = async () => {
    throw new Error('ipc');
  };
  await click(buttonByText('Move to Trash'));
  f.handlers.trashPasswordFile = async () => ({ ok: true });
  await click(buttonByText('Move to Trash'));
  assert.match(text('.import-note')!, /Passwords\.csv is in the Trash/);
  // choosing another browser forgets the file
  await click(buttonByText('Done'));
  await open([{ ...safari, status: 'ready' }, chrome]);
  await click(toggle('Saved passwords'));
  assert.equal(container.querySelector('.import-file'), null);
  await pick('chrome/Default');
  assert.equal(container.querySelector('.import-file'), null);
});

test("Safari's passwords that failed say what to do; a failed import offers no Trash", async () => {
  await open([{ ...safari, status: 'ready' }]);
  await click(toggle('Saved passwords'));
  await click(buttonByText('Choose file…'));
  f.handlers.start = async () => ({ ok: true, jobId: 'j1', sites: [], failed: {} });
  f.handlers.run = async () => ({ ok: true, results: { passwords: { status: 'failed', code: 'unsupported' } } });
  await click(buttonByText('Import'));
  await tick();
  assert.match(container.textContent!, /That file isn't a passwords export/);
  assert.equal(buttonByText('Move to Trash'), undefined);
  // another file, then Retry runs passwords again with it
  f.handlers.choosePasswordFile = async () => ({ name: 'Real.csv' });
  await click(buttonByText('Choose another file…'));
  assert.match(text('.import-file')!, /Real\.csv/);
  f.handlers.run = async () => ({ ok: true, results: { passwords: { status: 'failed', code: 'missing' } } });
  await click(buttonByText('Retry'));
  await tick();
  assert.match(container.textContent!, /Couldn't find the chosen passwords file/);
  f.handlers.run = async () => ({ ok: true, results: { passwords: { status: 'ok', imported: 3 } } });
  await click(buttonByText('Retry'));
  await tick();
  assert.equal(text('#import-title'), 'Import complete');
  assert.match(text('.import-note')!, /Real\.csv still holds your passwords/);
});
