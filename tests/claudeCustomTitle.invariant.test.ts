// The SDK's customTitle is also the CLI's own `ai-title`, so no main-process code but the title's readers and its
// rename owner may treat it as the name a Claude Code chat was given (electron/harness/claude/userTitle.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';
import { stripComments } from './support/source-strings.ts';

export const GUARDS = ['electron/'];

test("no main-process code decides a chat is named from the SDK's customTitle", () => {
  // The reader, rename owner, and display/search readers: the panel's native title never gates a rename.
  const allowed = new Set([
    'app/chromePanelIdentity',
    'harness/claude/userTitle',
    'harness/claude/rename',
    'harness/claude/transcripts',
    'app/ipc/chatList',
  ]);
  const hits = treeFiles('electron', /\.cjs$/)
    .filter((f: string) => !allowed.has(f.replace(/^electron\//, '').replace(/\.cjs$/, '')))
    .filter((f: string) => /\bcustomTitle\b/.test(stripComments(fs.readFileSync(f, 'utf8'))));
  assert.deepEqual(hits, []);
});
