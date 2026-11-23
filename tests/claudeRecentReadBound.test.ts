// The end of a Claude Code transcript is read in the time of the end, not of the file: a 100 MB transcript and a 10 MB one take alike, through the whole read a phone's chat.follow makes (the SDK on the end's lines, the core, the turns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptRecords, writeTranscript } from './support/claudeTranscriptFixture';

const require = createRequire(import.meta.url);
const { createTranscriptReader } = require('../electron/platform/claudeTranscriptRead.cjs');
const { allTurns, releaseHistory } = require('../electron/platform/claudeHistory.cjs');
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const { createPeerNativeReader } = require('../electron/session/peerNativeHistory.cjs');
const reader = createTranscriptReader({ noteIgnored: () => undefined });

/** How long the end of a transcript takes to read into turns, best of a few reads (a slow one is the machine's), and the turns read. */
async function timeEnd(file: string, sessionId: string) {
  let best = Infinity;
  let turns = 0;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    const answer = await reader.readTurnPage(
      { sdk },
      { sessionId, file, chatId: sessionId, cwd: '/work', uncached: true, recent: { bytes: 1024 * 1024 } },
    );
    try {
      assert.equal(answer.whole, false, 'a window of the end, not the file');
      turns = (await allTurns(answer.read)).length;
    } finally {
      releaseHistory(answer.read);
    }
    best = Math.min(best, performance.now() - started);
  }
  return { ms: best, turns };
}

test('the end of a 100 MB transcript reads in the time of the end of a 10 MB one, and well inside a budget', async () => {
  const small = writeTranscript({ sessionId: '00000000-0000-4000-8000-0000000000b1', turns: 1000, resultBytes: 4000 });
  const big = writeTranscript({ sessionId: '00000000-0000-4000-8000-0000000000b2', turns: 10_000, resultBytes: 4000 });
  try {
    assert.ok(small.size > 8e6 && small.size < 20e6, `${small.size} bytes`);
    assert.ok(big.size >= 100e6, `${big.size} bytes`);
    const a = await timeEnd(small.file, '00000000-0000-4000-8000-0000000000b1');
    const b = await timeEnd(big.file, '00000000-0000-4000-8000-0000000000b2');
    assert.ok(a.turns > 3 && b.turns > 3, `${a.turns} and ${b.turns} turns in a 1 MB window`);
    // the whole read of the 100 MB file takes seconds; its end takes what the end of the small one does (a generous bound for a loaded machine)
    assert.ok(b.ms < 1500, `${Math.round(b.ms)} ms for the end of ${Math.round(big.size / 1e6)} MB`);
    assert.ok(b.ms < a.ms * 5 + 400, `${Math.round(b.ms)} ms for 100 MB against ${Math.round(a.ms)} ms for 10 MB`);
  } finally {
    small.done();
    big.done();
  }
});

/** The turns of the end of a transcript (its last `bytes`) as the harness answers a peer's recent read. */
async function recentOf(file: string, sessionId: string, bytes: number) {
  const answer = await reader.readTurnPage(
    { sdk },
    { sessionId, file, chatId: sessionId, cwd: '/work', uncached: true, recent: { bytes } },
  );
  try {
    return {
      turns: await allTurns(answer.read),
      whole: answer.whole !== false,
      dangling: answer.dangling === true,
      compacted: answer.compacted === true,
    };
  } finally {
    releaseHistory(answer.read);
  }
}

test('a long line of the end has its tool results clipped, in each shape the CLI keeps them, and short ones are left as they are', async () => {
  const sessionId = '00000000-0000-4000-8000-0000000000c1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-clip-'));
  const file = path.join(dir, `${sessionId}.jsonl`);
  try {
    const lines: string[] = [];
    for (const record of transcriptRecords({ sessionId, turns: 30, resultBytes: 400 }) as Iterable<any>) {
      const block = record.message?.content?.[0];
      if (block?.type === 'tool_result' && String(block.tool_use_id).startsWith('toolu_29_')) {
        const first = block.tool_use_id === 'toolu_29_0';
        // as a block list, with a text over the clip and one under it, and a `toolUseResult` that nests strings in an object and an array
        block.content = first
          ? [
              { type: 'text', text: 'a'.repeat(300_000) },
              { type: 'text', text: 'short' },
            ]
          : 'd'.repeat(300_000);
        if (first) record.toolUseResult = { stdout: 'b'.repeat(300_000), parts: ['c'.repeat(300_000), 'ok'], n: 1 };
      }
      lines.push(JSON.stringify(record));
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const end = await recentOf(file, sessionId, fs.statSync(file).size - 50_000);
    assert.equal(end.whole, false, 'a window of the end');
    const text = JSON.stringify(end.turns);
    assert.ok(text.length < 400_000, `${text.length} characters for 300 KB results`);
    assert.ok(text.includes('more characters not read'));
    assert.ok(text.includes('short'), 'a text under the clip is whole');
    assert.ok(!/a{40000}|b{40000}|c{40000}|d{40000}/.test(text), 'no result keeps its length');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a chat whose last turn alone is huge is read at its end, never whole (#4097)', async () => {
  const sessionId = '00000000-0000-4000-8000-0000000000c2';
  const huge = writeTranscript({ sessionId, turns: 1, toolsPerTurn: 40, resultBytes: 1_000_000 });
  try {
    assert.ok(huge.size > 40e6, `${huge.size} bytes in one turn`);
    let whole = 0;
    const peer = createPeerNativeReader({
      claudeTurns: async () => (whole++, []),
      claudeRecent: (_id: string, _cwd: string, { bytes }: { bytes: number }) => recentOf(huge.file, sessionId, bytes),
      acpTurns: async () => ({ turns: [] }),
      codexTurns: async () => ({ data: [] }),
    });
    const started = performance.now();
    const read = await peer.recent({ kind: 'claude', nativeId: sessionId }, undefined, { open: false, enough: () => true });
    assert.equal(whole, 0, 'the whole history was not read');
    assert.equal(read.truncated, true, 'the start of the turn is not in what was read');
    assert.equal(read.turns.length, 1);
    assert.ok(read.turns[0].items.length > 0, 'its last rows are there');
    assert.ok(JSON.stringify(read.turns).length < 2_000_000, 'with its tool output clipped');
    assert.ok(performance.now() - started < 1500, 'in the time of a 21 MB read');
  } finally {
    huge.done();
  }
});
