// electron/platform/claudeEndTurnLines.cjs: the transcript lines that ended their turn on a tool result, read from the file past
// what was read before (whole lines only), and put back on the SDK's messages, which drop the flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { endTurnLines, withEndTurns, SCANS_MAX, CHUNK } = require('../electron/platform/claudeEndTurnLines.cjs');

const ended = (uuid: string) =>
  JSON.stringify({ type: 'user', uuid, message: { content: [{ type: 'tool_result' }] }, mcpMeta: { _meta: { 'claude/endTurn': true } } });
const plain = (uuid: string) => JSON.stringify({ type: 'user', uuid, message: { content: 'hi' } });

test('finds the flagged lines, reads on from where it stopped, waits for a half-written line and starts over on a shorter file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'end-turn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  // a line that only names the flag in its text, and one that is not JSON, are not ends of turns
  const named = JSON.stringify({ type: 'assistant', uuid: 'n', message: { content: 'the "claude/endTurn" key' } });
  fs.writeFileSync(file, [plain('a'), ended('b'), named, '{"claude/endTurn" broken', ''].join('\n'));
  assert.deepEqual([...(await endTurnLines(file))], ['b']);
  // a line still being written is read once it is whole
  fs.appendFileSync(file, ended('c').slice(0, 20));
  assert.deepEqual([...(await endTurnLines(file))], ['b']);
  fs.appendFileSync(file, `${ended('c').slice(20)}\n`);
  assert.deepEqual([...(await endTurnLines(file))], ['b', 'c']);
  // nothing new: the same answer
  assert.deepEqual([...(await endTurnLines(file))], ['b', 'c']);
  // rewritten shorter: read again from the start
  fs.writeFileSync(file, `${ended('d')}\n`);
  assert.deepEqual([...(await endTurnLines(file))], ['d']);
  // gone: what was found before; never read: none
  fs.rmSync(file);
  assert.deepEqual([...(await endTurnLines(file))], ['d']);
  assert.deepEqual([...(await endTurnLines(path.join(dir, 'never.jsonl')))], []);
});

test('keeps at most SCANS_MAX transcripts’ scans', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'end-turn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = Array.from({ length: SCANS_MAX + 1 }, (_, i) => path.join(dir, `${i}.jsonl`));
  for (const f of files) fs.writeFileSync(f, `${ended(path.basename(f))}\n`);
  for (const f of files) await endTurnLines(f);
  // the first one's scan was dropped: removed now, it reads as none rather than what it had
  fs.rmSync(files[0]);
  assert.deepEqual([...(await endTurnLines(files[0]))], []);
  assert.deepEqual([...(await endTurnLines(files[1]))], ['1.jsonl']);
});

test('a line across two reads is read whole; a file cut short after its size was read stops at what is there', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'end-turn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'big.jsonl');
  // a long line (a screenshot's) ends just past the first read, so the flagged line after it starts in the next one
  const filler = JSON.stringify({ type: 'user', uuid: 'img', data: 'x'.repeat(CHUNK - 40) });
  fs.writeFileSync(file, `${filler}\n${ended('far')}\n`);
  assert.deepEqual([...(await endTurnLines(file))], ['far']);
  // the file is shorter than its size said (cut between the two): the scan keeps what it read and goes on later
  const cut = path.join(dir, 'cut.jsonl');
  fs.writeFileSync(cut, `${ended('x')}\n`);
  const real = fs.promises.stat;
  t.mock.method(fs.promises, 'stat', async (f: string) => ({ ...(await real(f)), size: (await real(f)).size + 100 }));
  assert.deepEqual([...(await endTurnLines(cut))], ['x']);
  t.mock.restoreAll();
  fs.appendFileSync(cut, `${ended('y')}\n`);
  assert.deepEqual([...(await endTurnLines(cut))], ['x', 'y']);
});

test('withEndTurns puts the flag back on the lines that had it, and leaves the list as it is when none did', () => {
  const messages = [{ uuid: 'a' }, { uuid: 'b' }, null];
  assert.equal(withEndTurns(messages, new Set()), messages);
  assert.deepEqual(withEndTurns(messages, new Set(['b'])), [
    { uuid: 'a' },
    { uuid: 'b', mcpMeta: { _meta: { 'claude/endTurn': true } } },
    null,
  ]);
});
