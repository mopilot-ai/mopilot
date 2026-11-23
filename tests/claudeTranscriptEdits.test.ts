import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { checkpointsOf } from './support/checkpoints-of.ts';
const require = createRequire(import.meta.url);
const { forkPoint } = require('../electron/harness/claude/transcriptEdits.cjs');

test('fork retains tool results, metadata, synthetic prompts and assistant messages until the next real prompt', () => {
  const messages = [
    { uuid: 'p1', type: 'user', message: { content: 'first' } },
    { uuid: 'a1', type: 'assistant' },
    { uuid: 'result', type: 'user', message: { content: [{ type: 'tool_result' }, null] } },
    { uuid: 'meta', type: 'user', isMeta: true },
    { uuid: 'goal', type: 'user', isSynthetic: true },
    { type: 'user', message: { content: 42 } },
    null,
    { uuid: 'a2', type: 'assistant' },
    { uuid: 'p2', type: 'user', message: { content: [{ type: 'image' }] } },
    { uuid: 'p3', type: 'user', message: { content: [null, { type: 'text' }] } },
  ];
  // Missing UUIDs are skipped; null messages are not part of the native protocol.
  messages.splice(6, 1);
  assert.equal(forkPoint(messages, 'p1'), 'a2');
  assert.equal(forkPoint(messages, 'p2'), 'p2');
  assert.equal(forkPoint(messages, 'p3'), 'p3');
  assert.equal(forkPoint(messages, 'missing'), null);
  assert.equal(forkPoint(null, 'missing'), null);
});

test('a fork from a turn a compaction followed ends before the boundary, listed with or without its subtype', () => {
  const messages = [
    { uuid: 'p1', type: 'user', message: { content: 'first' } },
    { uuid: 'a1', type: 'assistant' },
    { uuid: 'note', type: 'system', subtype: 'informational' },
    { uuid: 'b1', type: 'system' },
    { uuid: 's1', type: 'user', isCompactSummary: true, message: { content: 'summary' } },
    { uuid: 'p2', type: 'user', message: { content: 'second' } },
    { uuid: 'a2', type: 'assistant' },
    { uuid: 'b2', type: 'system', subtype: 'compact_boundary' },
    { uuid: 's2', type: 'user', isCompactSummary: true, message: { content: 'summary' } },
  ];
  assert.equal(forkPoint(messages, 'p1'), 'a1');
  assert.equal(forkPoint(messages, 'p2'), 'a2');
  // the compaction cut a turn in two: the messages it kept come back after the summary and are still that turn's
  assert.equal(
    forkPoint(
      [
        { uuid: 'p', type: 'user', message: { content: 'x' } },
        { uuid: 'a', type: 'assistant' },
        { uuid: 'b', type: 'system' },
        { uuid: 's', type: 'user', isCompactSummary: true, message: { content: 'summary' } },
        { uuid: 'kept', type: 'assistant' },
        { uuid: 'next', type: 'user', message: { content: 'y' } },
      ],
      'p',
    ),
    'kept',
  );
  // a notice inside a turn that goes on is still part of it, and a message with no uuid is skipped
  assert.equal(
    forkPoint(
      [
        { uuid: 'p', type: 'user', message: { content: 'x' } },
        { uuid: 'n', type: 'system' },
        { uuid: 'a', type: 'assistant' },
        { uuid: 'z' },
        {},
      ],
      'p',
    ),
    'z',
  );
  assert.equal(
    forkPoint(
      [
        { uuid: 'p', type: 'user', message: { content: 'x' } },
        { uuid: 'n', type: 'system' },
      ],
      'p',
    ),
    'n',
  );
});

test('checkpoints require both a user chain entry and an original file snapshot; partial lines are ignored', async () => {
  const rows = [
    { type: 'user', uuid: 'first' },
    { type: 'user', uuid: 'second', parentUuid: 'assistant' },
    { type: 'file-history-snapshot', messageId: 'first' },
    { type: 'file-history-snapshot', messageId: 'second' },
    { type: 'file-history-snapshot', messageId: 'second', isSnapshotUpdate: true },
    { type: 'file-history-snapshot', messageId: 'orphan' },
    { type: 'file-history-snapshot' },
    { type: 'user' },
    { type: 'assistant' },
  ].map((r) => JSON.stringify(r));
  rows.push('{"type":"user", broken', '{"type":"user"}');
  assert.deepEqual(await checkpointsOf(rows.join('\n')), { first: null, second: 'assistant' });
  assert.deepEqual(await checkpointsOf(''), {});
});

test('checkpoint discovery follows decoded JSON fields rather than serialized marker bytes', async () => {
  const text = [
    '{ "type" : "user", "uuid" : "prompt", "parentUuid" : "before" }',
    String.raw`{"type":"file-history-snap\u0073hot","messageId":"prompt"}`,
  ].join('\n');
  assert.deepEqual(await checkpointsOf(text), { prompt: 'before' });
});

test('only lines that can be a snapshot or the user record it names are read, with the same answer as reading them all', async () => {
  const big = { type: 'assistant', uuid: 'reply', message: { content: 'x'.repeat(1000) } };
  const text = [
    JSON.stringify({ type: 'user', uuid: 'prompt', parentUuid: 'before', message: { content: 'hi' } }),
    JSON.stringify(big),
    // a user record whose uuid names no snapshot, and one that does but is torn
    JSON.stringify({ type: 'user', uuid: 'other', parentUuid: 'x' }),
    '{"type":"user","uuid":"torn", broken',
    // an assistant record and a tool result naming the snapshot's message are not the message
    JSON.stringify({ type: 'assistant', uuid: 'prompt2', parentUuid: 'not-user' }),
    JSON.stringify({ type: 'user', uuid: 'r1', toolUseResult: { uuid: 'prompt2' }, parentUuid: 'tool' }),
    // a line that mentions the marker without being a snapshot, and a torn snapshot
    JSON.stringify({ type: 'user', uuid: 'said', message: { content: 'file-history-snapshot' } }),
    '{"type":"file-history-snapshot", broken',
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'prompt' }),
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'prompt2' }),
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'torn' }),
    // a uuid with an escape is decoded before it is compared
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'q"uote' }),
    JSON.stringify({ type: 'user', uuid: 'q"uote', parentUuid: 'p-quote' }),
    String.raw`{"type":"us\u0065r","uuid":"prompt3","parentUuid":"escaped"}`,
    // escaped lines that are not the user record a snapshot names
    String.raw`{"type":"assistant","uuid":"prompt3","note":"\u0041"}`,
    String.raw`{"type":"user","uuid":"unnamed","note":"\u0041"}`,
    String.raw`{"type":"user","uuid":"torn-escape \u0041`,
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'prompt3' }),
  ].join('\n');
  assert.deepEqual(await checkpointsOf(text), { prompt: 'before', 'q"uote': 'p-quote', prompt3: 'escaped' });
  // with no snapshot, no user record is read at all
  assert.deepEqual(await checkpointsOf(JSON.stringify({ type: 'user', uuid: 'prompt' })), {});
});
