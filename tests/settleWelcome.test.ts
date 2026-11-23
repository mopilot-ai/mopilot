// electron/platform/chats.cjs settleWelcome: whether the welcome page was finished, settled once before any window boots (#2034).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { settleWelcome } = createRequire(import.meta.url)('../electron/platform/chats.cjs');
const { flushPendingWrites } = createRequire(import.meta.url)('../electron/platform/chats.cjs');

const settle = (saved: unknown) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'welcome-'));
  const file = path.join(dir, 'ui-state.json');
  if (saved !== undefined) fs.writeFileSync(file, JSON.stringify(saved));
  const written = settleWelcome(file);
  flushPendingWrites();
  const prefs = JSON.parse(fs.readFileSync(file, 'utf8')).prefs;
  fs.rmSync(dir, { recursive: true, force: true });
  return { written, prefs };
};

test('a new install is welcomed until Continue, even once main saved prefs of its own before the window', () => {
  assert.equal(settle(undefined).prefs.welcomeDone, false);
  // main's own keys (a usage choice read from the account) say nothing about a window having run
  assert.deepEqual(settle({ prefs: { shareUsageData: true } }).prefs, { shareUsageData: true, welcomeDone: false });
});

test('an install a window already saved its state in was set up before the page kept the mark', () => {
  assert.equal(settle({ sidebarOpen: true, prefs: { fontSize: 18 } }).prefs.welcomeDone, true);
  assert.equal(settle({ projects: [] }).prefs.welcomeDone, true);
});

test('a settled mark stands and is not written again, so windows that boot together agree', () => {
  for (const welcomeDone of [false, true]) {
    const { written, prefs } = settle({ sidebarOpen: true, prefs: { welcomeDone } });
    assert.equal(written, null);
    assert.equal(prefs.welcomeDone, welcomeDone);
  }
});
