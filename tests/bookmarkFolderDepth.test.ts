// Imported bookmark paths preserve twelve source folders plus their generated root after reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { BookmarkStore } = createRequire(import.meta.url)('../electron/capabilities/browser/bookmarkStore.cjs');
function bookmarks() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bookmark-depth-')), 'sub', 'bookmarks.json');
  return { file, make: () => new BookmarkStore({ file, now: () => 1000 }) };
}

test('BookmarkStore.importItems: deep folders round-trip and repeated imports stay deduplicated after restart', () => {
  const { make } = bookmarks();
  const folders = Array.from({ length: 12 }, (_, i) => `Folder ${i}`);
  const incoming = [{ url: 'https://deep.test/', title: 'Deep', folderPath: folders }];
  const store = make();
  assert.equal(store.importItems(incoming, 'Chrome', 'chrome').imported, 1);
  const before = store.list();
  assert.deepEqual(before[0].folderPath, ['Imported from Chrome', ...folders]);
  const restarted = make();
  assert.deepEqual(restarted.list(), before);
  assert.equal(restarted.importItems(incoming, 'Chrome', 'chrome').skippedExisting, 1);
  assert.equal(restarted.list().length, 1);
});

test('BookmarkStore: loaded local folders retain their own twelve-folder limit', () => {
  const { file, make } = bookmarks();
  const folders = Array.from({ length: 14 }, (_, i) => `Folder ${i}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ items: [{ id: 'local', url: 'https://local.test/', source: 'local', folderPath: folders }] }));
  assert.deepEqual(make().list()[0].folderPath, folders.slice(0, 12));
});
