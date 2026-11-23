// What a chat's saved history is now, as a string that changes when the history does (#5379): the transcript's file and state for Claude, through the native reader, the chat's segments and the panel's history reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { writeTranscript } from './support/claudeTranscriptFixture';

const require = createRequire(import.meta.url);
const { createTranscripts } = require('../electron/harness/claude/transcripts.cjs');
const { createPeerNativeReader, claudePeerSource } = require('../electron/session/peerNativeHistory.cjs');
const { peerHistoryReader } = require('../electron/session/peerTranscript.cjs');
const { createHistoryReader } = require('../electron/app/chromePanelHistory.cjs');

const SID = '00000000-0000-4000-8000-0000000000cc';
const fixture = writeTranscript({ sessionId: SID, turns: 6, toolsPerTurn: 1, resultBytes: 100 });
test.after(() => fixture.done());
const sdk = { getSessionMessages: async () => [] };
const transcripts = createTranscripts({ sdk: async () => sdk, resumeAt: new Map() }, null);

test('a Claude transcript names its file, inode, size and time: an append and a rewrite change it, and no transcript has none', async () => {
  const first = await transcripts.stamp(SID);
  assert.match(first, new RegExp(`${SID}\\.jsonl:\\d+:\\d+:[\\d.]+$`));
  assert.equal(await transcripts.stamp(SID), first, 'nothing changed: the same stamp');
  fs.appendFileSync(fixture.file, '{"type":"system","subtype":"x"}\n');
  const appended = await transcripts.stamp(SID);
  assert.notEqual(appended, first, 'an append (a turn, or a compaction boundary written at the end)');
  const copy = fs.readFileSync(fixture.file);
  fs.writeFileSync(fixture.file, copy.subarray(0, copy.length - 10));
  assert.notEqual(await transcripts.stamp(SID), appended, 'a file written shorter');
  assert.equal(await transcripts.stamp('00000000-0000-4000-8000-0000000000dd'), null);
  // a file that is there for the lookup and gone for the stat
  const gone = createTranscripts({ sdk: async () => sdk, resumeAt: new Map() }, null);
  const real = fs.promises.stat;
  (fs.promises as any).stat = async () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  };
  try {
    assert.equal(await gone.stamp(SID), null);
  } finally {
    (fs.promises as any).stat = real;
  }
});

test('the native reader stamps a Claude segment from its transcript, and every other family, or a Claude source with no stamp, has none', async () => {
  const stamp = async (id: string) => `stamp of ${id}`;
  const reader = createPeerNativeReader({
    claudeTurns: async () => [],
    claudeStamp: stamp,
    acpTurns: async () => ({}),
    codexTurns: async () => ({}),
    codexStamp: async (id: string) => `codex ${id}`,
  });
  assert.equal(await reader.stamp({ kind: 'claude', nativeId: 'n1' }), 'stamp of n1');
  assert.equal(await reader.stamp({ kind: 'codex', nativeId: 'n1' }), 'codex n1');
  assert.equal(
    await reader.stamp({ kind: 'acp:gemini', nativeId: 'n1' }),
    null,
    'ACP opens its history inside the core, which does not say which file: read at every page',
  );
  assert.equal(await reader.stamp({ kind: 'nonsense', nativeId: 'n1' }), null);
  const noRollout = createPeerNativeReader({
    claudeTurns: async () => [],
    acpTurns: async () => ({}),
    codexTurns: async () => ({}),
    codexStamp: async () => null,
  });
  assert.equal(await noRollout.stamp({ kind: 'codex', nativeId: 'n1' }), null, 'a thread with no rollout file');
  // the default is the rollout service, under the CODEX_HOME the app-server runs with: a thread with no file there has no stamp
  const home = fs.mkdtempSync(`${os.tmpdir()}/codex-stamp-`);
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const byDefault = createPeerNativeReader({ claudeTurns: async () => [], acpTurns: async () => ({}), codexTurns: async () => ({}) });
    assert.equal(await byDefault.stamp({ kind: 'codex', nativeId: '00000000-0000-7000-8000-000000000009' }), null);
  } finally {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
  }
  const none = createPeerNativeReader({ claudeTurns: async () => [], acpTurns: async () => ({}), codexTurns: async () => ({}) });
  assert.equal(await none.stamp({ kind: 'claude', nativeId: 'n1' }), null);
  const empty = createPeerNativeReader({
    claudeTurns: async () => [],
    claudeStamp: async () => '',
    acpTurns: async () => ({}),
    codexTurns: async () => ({}),
  });
  assert.equal(await empty.stamp({ kind: 'claude', nativeId: 'n1' }), null);
  // the Claude source takes the harness's stamp when it has one
  assert.equal(typeof claudePeerSource({ stamp, allTurns: async () => [], replies: async () => [] }).claudeStamp, 'function');
  assert.equal(await claudePeerSource({ stamp, allTurns: async () => [], replies: async () => [] }).claudeStamp('x'), 'stamp of x');
  assert.equal('claudeStamp' in claudePeerSource({ allTurns: async () => [], replies: async () => [] }), false);
});

test('a chat is stamped by all of its segments, so a switch of harness changes it, and by nothing when any segment cannot say', async () => {
  const records = new Map<string, any>([
    ['one', { segments: [{ kind: 'claude', nativeId: 'a' }] }],
    [
      'two',
      {
        segments: [
          { kind: 'claude', nativeId: 'a' },
          { kind: 'claude', nativeId: 'b' },
        ],
      },
    ],
    [
      'mixed',
      {
        segments: [
          { kind: 'claude', nativeId: 'a' },
          { kind: 'acp:gemini', nativeId: 'b' },
        ],
      },
    ],
    [
      'switched',
      {
        segments: [
          { kind: 'claude', nativeId: 'a' },
          { kind: 'codex', nativeId: 'b' },
        ],
      },
    ],
    ['empty', { segments: [] }],
  ]);
  const native: any = createPeerNativeReader({
    claudeTurns: async () => [],
    codexStamp: async (id: string) => `c-${id}`,
    claudeStamp: async (id: string) => `s-${id}`,
    acpTurns: async () => ({}),
    codexTurns: async () => ({}),
  });
  const history = peerHistoryReader({ records }, () => native);
  const one = await history.stamp('one');
  assert.deepEqual(JSON.parse(one), [['claude', 'a', 's-a']]);
  assert.notEqual(await history.stamp('two'), one);
  assert.equal(await history.stamp('mixed'), null, 'one family (ACP) cannot say: nothing made from the chat is held');
  assert.deepEqual(JSON.parse((await history.stamp('switched')) as string), [
    ['claude', 'a', 's-a'],
    ['codex', 'b', 'c-b'],
  ]);
  assert.equal(await history.stamp('empty'), null);
  assert.equal(await history.stamp('nobody'), null);
  const bare = peerHistoryReader({ records }, () => ({}));
  assert.equal(await bare.stamp('one'), null, 'a native reader with no stamp');
});

test('the panel history reader gives the stamp of the peer runtime, or none when the runtime has none', async () => {
  const live: any = {
    peerRuntime: { readHistory: Object.assign(async () => ({ turns: [] }), { stamp: async (id: string) => `p-${id}` }) },
  };
  assert.equal(await createHistoryReader(live).stamp('c'), 'p-c');
  assert.equal(await createHistoryReader({ peerRuntime: { readHistory: async () => ({ turns: [] }) } }).stamp('c'), null);
  assert.equal(await createHistoryReader({}).stamp('c'), null);
});
