// Telling a live Claude CLI's own transcript writes from another app's (records are made up).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const { tail, tipOf, ownTipOf, cliUserLine } = createRequire(import.meta.url)('../electron/harness/claude/transcriptStep.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-transcript-'));

let n = 0;
function file(rows: object[]) {
  const f = path.join(tmp, `${n++}.jsonl`);
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
const user = (uuid: string, parentUuid: string | null, content: unknown) => ({
  type: 'user',
  uuid,
  parentUuid,
  message: { role: 'user', content },
});
const answer = (uuid: string, parentUuid: string) => ({
  type: 'assistant',
  uuid,
  parentUuid,
  message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
});
const note = (uuid: string, parentUuid: string) => ({ type: 'system', uuid, parentUuid, subtype: 'turn_duration' });

test('the tip is the newest message, skipping records that are not messages', () => {
  const f = file([
    { type: 'queue-operation' },
    user('u1', null, 'hi'),
    answer('a1', 'u1'),
    note('s1', 'a1'),
    { type: 'custom-title', customTitle: 'x' },
  ]);
  assert.equal(tipOf(f), 'a1');
  assert.equal(tipOf(null), null);
  assert.equal(tipOf(file([{ type: 'queue-operation' }])), null);
});

test('a long first line (a pasted image) does not hide the tip', () => {
  const f = file([
    user('u1', null, [
      { type: 'text', text: 'look' },
      { type: 'image', data: 'x'.repeat(600_000) },
    ]),
    answer('a1', 'u1'),
  ]);
  assert.equal(tipOf(f), 'a1');
  assert.equal(tipOf(file([user('u1', null, 'y'.repeat(600_000))])), 'u1');
});

test('a process owns the tip when everything after its last answer is its own', () => {
  const f = file([
    user('u1', null, 'hi'),
    answer('a1', 'u1'),
    note('s1', 'a1'),
    user('u2', 's1', 'next'),
    answer('a2', 'u2'),
    user('t1', 'a2', [{ type: 'tool_result', content: 'done' }]),
    answer('a3', 't1'),
  ]);
  assert.equal(ownTipOf(f, new Set(['a2', 'a3'])), 'a3');
  // an interrupt marker the CLI wrote after the last streamed answer
  const g = file([user('u1', null, 'hi'), answer('a1', 'u1'), user('i1', 'a1', [{ type: 'text', text: '[Request interrupted by user]' }])]);
  assert.equal(ownTipOf(g, new Set(['a1'])), 'i1');
  // a prompt it sent that got no reply (a local command like "/goal clear")
  const h = file([user('u1', null, 'hi'), answer('a1', 'u1'), user('c1', 'a1', '/goal clear')]);
  assert.equal(ownTipOf(h, new Set(['a1', 'c1'])), 'c1');
  assert.equal(ownTipOf(h, new Set(['a1'])), false);
});

test('a turn another app added makes the process behind', () => {
  // the other app resumed from disk after a1 and asked its own question
  const f = file([user('u1', null, 'hi'), answer('a1', 'u1'), user('x1', 'a1', 'from elsewhere'), answer('x2', 'x1')]);
  assert.equal(ownTipOf(f, new Set(['a1'])), false);
  // the other app wrote while this process ran: its answer hangs off this process's turn
  const g = file([user('u1', null, 'hi'), answer('a1', 'u1'), user('x1', 'a1', 'from elsewhere')]);
  assert.equal(ownTipOf(g, new Set(['a1'])), false);
  assert.equal(ownTipOf(file([]), new Set()), null);
});

test('only CLI-written user lines count as the process own', () => {
  assert.equal(cliUserLine(user('t', 'a', [{ type: 'tool_result', content: 'x' }])), true);
  assert.equal(cliUserLine(user('i', 'a', '[Request interrupted by user for tool use]')), true);
  assert.equal(cliUserLine(user('p', 'a', 'a real prompt')), false);
  // a goal's unmet check and a local command's output
  assert.equal(cliUserLine(user('g', 'a', [{ type: 'text', text: 'Stop hook feedback:\n[tests pass]: 2 fail' }])), true);
  assert.equal(cliUserLine({ ...user('g', 'a', 'anything'), isMeta: true }), true);
  assert.equal(cliUserLine(user('o', 'a', '<local-command-stdout>Goal cleared: tests pass</local-command-stdout>')), true);
  assert.equal(
    cliUserLine(
      user('p', 'a', [
        { type: 'text', text: 'a real prompt' },
        { type: 'tool_result', content: 'x' },
      ]),
    ),
    false,
  );
});

test('transcript polling reads valid JSON separators instead of requiring compact serialization', () => {
  for (const type of ['user', 'assistant']) {
    const f = file([user('old', null, 'old')]);
    fs.appendFileSync(f, `{ "type" \t: \t"${type}", "uuid" : "latest", "parentUuid" : "old" }\n`);
    assert.equal(tipOf(f), 'latest');
    assert.deepEqual(
      tail(f, 2).map((row: any) => row.uuid),
      ['old', 'latest'],
    );
  }
});

test('transcript fields follow JSON escape decoding in both message and chain reads', () => {
  const f = file([user('old', null, 'old')]);
  fs.appendFileSync(f, String.raw`{"t\u0079pe":"assi\u0073tant","u\u0075id":"latest","parentUuid":"old"}` + '\n');
  assert.equal(tipOf(f), 'latest');
  assert.deepEqual(
    tail(f, 2, true).map((row: any) => row.uuid),
    ['old', 'latest'],
  );
});

test('cyclic parent links return an unclaimed tip instead of blocking the main process', () => {
  for (const rows of [
    [user('loop', 'loop', 'Stop hook feedback: still working')],
    [note('s1', 's2'), note('s2', 's1'), user('loop', 's1', 'Stop hook feedback: still working')],
  ]) {
    const f = file(rows);
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        'console.log(JSON.stringify(require(process.argv[1]).ownTipOf(process.argv[2], new Set())))',
        path.resolve('electron/harness/claude/transcriptStep.cjs'),
        f,
      ],
      { timeout: 2000, encoding: 'utf8' },
    );
    assert.equal(result.error, undefined, 'the ancestry walk must finish');
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'false');
  }
});

test('a known tip remains claimable without traversing an older malformed parent chain', () => {
  const f = file([user('known', 'known', 'Stop hook feedback: still working')]);
  assert.equal(ownTipOf(f, new Set(['known'])), 'known');
});

test('malformed content blocks cannot throw or establish CLI ownership', () => {
  for (const content of [[], [null], [null, { type: 'tool_result' }], [42], [['text']], { type: 'tool_result' }]) {
    const row = user('broken', 'known', content);
    assert.equal(cliUserLine(row), false);
    assert.equal(ownTipOf(file([answer('known', 'u'), row]), new Set(['known'])), false);
  }
});

test('CLI text and metadata markers require their recorded field types', () => {
  for (const text of [null, 42, ['Stop hook feedback: x'], { value: 'Stop hook feedback: x' }]) {
    assert.equal(cliUserLine(user('bad', 'known', [{ type: 'text', text }])), false);
  }
  for (const isMeta of ['false', 1, {}]) assert.equal(cliUserLine({ ...user('bad', 'known', 'foreign prompt'), isMeta }), false);
});
