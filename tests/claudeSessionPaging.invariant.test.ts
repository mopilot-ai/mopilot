// The SDK's listSessions reads every transcript up to the end of the page it is asked for, so main asks it for pages in
// one place only (electron/harness/claude/sessionList.cjs), which cuts every page and caller from one listing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';
import { stripComments } from './support/source-strings.ts';

export const GUARDS = ['electron/'];

test("no main-process code but the session list asks the SDK's listSessions for a page", () => {
  const hits = treeFiles('electron', /\.cjs$/)
    .filter((f: string) => f !== 'electron/harness/claude/sessionList.cjs')
    .filter((f: string) => /\blistSessions\(\{[^}]*\b(limit|offset)\b/.test(stripComments(fs.readFileSync(f, 'utf8'))));
  assert.deepEqual(hits, [], 'page the session list through createSessionList (sessionList.cjs) instead');
});

test('the guard flags a paged listing, and passes a whole one', () => {
  const pattern = /\blistSessions\(\{[^}]*\b(limit|offset)\b/;
  assert.ok(pattern.test('await (await state.sdk()).listSessions({ limit, offset })'));
  assert.ok(pattern.test('sdk.listSessions({ offset: 10 })'));
  assert.ok(!pattern.test('await (await state.sdk()).listSessions({})'));
  assert.ok(!pattern.test('claude.listSessions(CLAUDE_PAGE, offset)'));
});
