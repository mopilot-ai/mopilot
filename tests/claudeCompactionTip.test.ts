// A Claude Code compaction is the CLI's own writing (electron/harness/claude/transcriptStep.cjs): a turn stopped right after an automatic
// compaction leaves the summary as the transcript's newest line, and the process that ran it still owns that tip. Lines
// follow Claude Code 2.1's records (a compact_boundary with no parent, its logicalParentUuid, then the isCompactSummary
// user line; a /compact adds its command and output lines after the summary).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ownTipOf, cliUserLine } = require('../electron/harness/claude/transcriptStep.cjs');

const write = (rows: object[]) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctip-')), 's.jsonl');
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n'));
  return f;
};
const said = { type: 'assistant', uuid: 'a1', parentUuid: 'p1', message: { content: [{ type: 'text', text: 'Done.' }] } };
const prompt = { type: 'user', uuid: 'p1', parentUuid: null, message: { content: 'Fix it' } };
const boundary = {
  type: 'system',
  subtype: 'compact_boundary',
  uuid: 'b1',
  parentUuid: null,
  logicalParentUuid: 'a1',
  compactMetadata: { trigger: 'manual' },
};
const summary = {
  type: 'user',
  uuid: 's1',
  parentUuid: 'b1',
  isCompactSummary: true,
  isVisibleInTranscriptOnly: true,
  message: { content: 'This session is being continued from a previous conversation that ran out of context.' },
};
const caveat = { type: 'user', uuid: 'c1', parentUuid: 's1', isMeta: true, message: { content: '<local-command-caveat>' } };
const stdout = {
  type: 'user',
  uuid: 'o1',
  parentUuid: 'c1',
  message: { content: '<local-command-stdout>Compacted</local-command-stdout>' },
};

test('a compaction summary is a line the CLI wrote, not a prompt', () => {
  assert.equal(cliUserLine(summary), true);
  assert.equal(cliUserLine({ ...summary, isCompactSummary: false }), false);
});

test('a turn stopped right after an automatic compaction keeps its tip: the walk goes on past the boundary', () => {
  // the prompt this process sent, Claude Code's compaction before it answered, then the Stop: nothing seen after it
  const auto = { ...boundary, logicalParentUuid: 'p1', compactMetadata: { trigger: 'auto' } };
  assert.equal(ownTipOf(write([prompt, auto, summary]), new Set(['p1'])), 's1');
  // Claude Code's own /compact lines after a summary (the command under the uuid this process sent): its tip as before
  const command = { type: 'user', uuid: 'k1', parentUuid: 'c1', message: { content: '<command-name>/compact</command-name>' } };
  const out = { ...stdout, parentUuid: 'k1' };
  assert.equal(ownTipOf(write([prompt, said, boundary, summary, caveat, command, out]), new Set(['a1', 'k1'])), 'o1');
  // another app's prompt after the compaction still means this process is behind
  assert.equal(
    ownTipOf(
      write([prompt, said, boundary, summary, { type: 'user', uuid: 'x', parentUuid: 's1', message: { content: 'hi' } }]),
      new Set(['a1']),
    ),
    false,
  );
  // a boundary whose logical parent is out of the tail read is where the walk ends, as before
  assert.equal(ownTipOf(write([boundary, summary, caveat, stdout]), new Set(['a1'])), false);
  // only a compaction's boundary is walked past by its logical parent
  assert.equal(ownTipOf(write([prompt, said, { ...boundary, subtype: 'other' }, summary]), new Set(['a1'])), false);
});
