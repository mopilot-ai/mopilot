// A Claude Code transcript searched for a word through the Rust core (electron/harness/claude/transcripts.cjs transcriptHas): a file gone since it was listed holds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transcriptHas } = require('../electron/harness/claude/transcripts.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

test('a transcript holds the word it was searched for, and one gone since it was listed holds nothing, noted', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-has-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'find the needle' } })}\n`);
  assert.equal(await transcriptHas(file, 'needle'), true);
  assert.equal(await transcriptHas(file, 'thread'), false);
  assert.equal(await transcriptHas(path.join(dir, 'gone.jsonl'), 'needle'), false);
  assert.ok(recentIgnored().some((e: any) => e.context === 'search a Claude Code transcript'));
});
