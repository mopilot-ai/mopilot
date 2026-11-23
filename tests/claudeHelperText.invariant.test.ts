// A Claude Code helper query never joins raw assistant text (#3046): the CLI answers a query it can't run (the account is at
// its limit) with a synthetic assistant message holding the error as text, so a helper that collected every text block kept
// "You've hit your monthly spend limit" as a chat's title or a handoff note. Helpers read replies through helperReply.cjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const GUARDS = ['electron/harness/claude/'];

const DIR = path.join(import.meta.dirname, '..', 'electron', 'harness', 'claude');

test('no Claude helper joins assistant text blocks itself; helperReply.cjs (which skips error replies) is the one place', () => {
  const joiners = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.cjs') && f !== 'helperReply.cjs')
    .map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')])
    // a reader that joins the text itself must leave the error replies out
    .filter(([, source]) => /type === 'text'\)\s*\w+ \+= /.test(source) && !source.includes('isSyntheticAssistant'))
    .map(([f]) => f);
  assert.deepEqual(joiners, [], 'read the reply with helperReply(), or skip isSyntheticAssistant messages');
});
