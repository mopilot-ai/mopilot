// The renderer's side of importing from another browser (src/lib/browserImport.ts): the dialog event, how failures read, which sources the
// first-run offer names, and when the offer returns after "Not now" (1, 3, then 7 days).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { IMPORT_EVENT, SNOOZE_DAYS, importErrorText, offerDue, offerSources, openImportDialog, snoozed } from '../src/lib/browserImport.ts';

const DAY = 86_400_000;

test('openImportDialog: tells the dialog which browser to preselect, or none', () => {
  const seen: unknown[] = [];
  const on = (e: any) => {
    seen.push(e.detail);
  };
  window.addEventListener(IMPORT_EVENT, on);
  openImportDialog();
  openImportDialog('safari');
  window.removeEventListener(IMPORT_EVENT, on);
  assert.deepEqual(seen, [null, 'safari']);
  assert.match(importErrorText('storage_unavailable', 'Chrome'), /can't encrypt saved passwords/);
});

test('importErrorText: each failure says what happened and what to do, naming the browser', () => {
  assert.match(importErrorText('keychain_denied', 'Chrome'), /sign-in key.*choose Allow/);
  assert.match(importErrorText('access_blocked', 'Safari', 'history'), /Safari's history.*Full Disk Access/);
  // a switch already on can belong to an older copy of the app: say how to point it at this one
  assert.match(
    importErrorText('access_blocked', 'Safari', 'history'),
    /Already on\? .*remove it with −, add it again with \+, then quit and reopen MoPilot\./,
  );
  assert.match(importErrorText('access_blocked', 'Safari'), /Safari's data/);
  assert.match(importErrorText('missing', 'Chrome', 'bookmarks'), /Couldn't find Chrome's bookmarks/);
  assert.match(importErrorText('too_large', 'Chrome', 'history'), /too large/);
  assert.match(importErrorText('busy', 'Chrome'), /Another import/);
  assert.match(importErrorText('cancelled', 'Chrome'), /cancelled/);
  assert.match(importErrorText('unsupported', 'Chrome'), /can't be imported from on this Mac/);
  assert.match(
    importErrorText('unsupported', 'Safari', 'passwords'),
    /That file isn't a passwords export\. In Safari, choose File → Export → Passwords…/,
  );
  assert.equal(importErrorText('no_file', 'Safari', 'passwords'), 'Choose the passwords file Safari exported, then try again.');
  // a file the user chose is not the browser's profile
  assert.match(importErrorText('missing', 'Safari', 'passwords', true), /Couldn't find the chosen passwords file/);
  assert.match(importErrorText('access_blocked', 'Safari', 'passwords', true), /blocked access to the chosen passwords file/);
  assert.match(importErrorText('too_large', 'Safari', 'passwords', true), /too large to be a passwords export/);
  assert.match(importErrorText('unsupported', 'Safari', 'passwords', true), /isn't a passwords export/);
  assert.match(importErrorText('missing', 'Safari', 'passwords'), /Open Safari once/);
  assert.match(importErrorText('read_failed', 'Chrome', 'cookies'), /Quit Chrome and try again/);
  assert.match(importErrorText('anything else', 'Arc'), /Quit Arc/);
});

test('offerSources and offerDue: browsers that can be read (or could be with Full Disk Access), while the offer is pending and not put off', () => {
  const s = (id: string, status: string) => ({ id, status }) as any;
  assert.deepEqual(
    offerSources([s('a', 'ready'), s('b', 'not_installed'), s('c', 'needs_full_disk_access'), s('d', 'unsupported')]).map((x) => x.id),
    ['a', 'c'],
  );
  assert.equal(offerDue({ browserImportPrompt: 'pending', browserImportSnoozeUntil: 0 }, 100), true);
  assert.equal(offerDue({ browserImportPrompt: 'pending', browserImportSnoozeUntil: 100 }, 100), true);
  assert.equal(offerDue({ browserImportPrompt: 'pending', browserImportSnoozeUntil: 101 }, 100), false);
  assert.equal(offerDue({ browserImportPrompt: 'dismissed', browserImportSnoozeUntil: 0 }, 100), false);
  assert.equal(offerDue({ browserImportPrompt: 'done', browserImportSnoozeUntil: 0 }, 100), false);
});

test('snoozed: the offer returns after 1, then 3, then 7 days, and 7 from then on', () => {
  assert.deepEqual(SNOOZE_DAYS, [1, 3, 7]);
  const now = 1_000_000;
  assert.deepEqual(snoozed(0, now), { browserImportSnoozes: 1, browserImportSnoozeUntil: now + DAY });
  assert.deepEqual(snoozed(1, now), { browserImportSnoozes: 2, browserImportSnoozeUntil: now + 3 * DAY });
  assert.deepEqual(snoozed(2, now), { browserImportSnoozes: 3, browserImportSnoozeUntil: now + 7 * DAY });
  assert.deepEqual(snoozed(9, now), { browserImportSnoozes: 10, browserImportSnoozeUntil: now + 7 * DAY });
});
