// Pure pieces of the multi-harness work: user text cleanup and plan labels (examples are made up).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// src/ imports its siblings without the `.ts` extension (Vite resolves them); do the same here.
const { parseUserText, extractReplyQuotes } = await import('../src/lib/format.ts');
const { claudePlanLabel, claudeSessionId, claudeThreadId } = await import('../src/harness/types.ts');
const { noteOwner, ownerOf, noteSegments } = await import('../src/harness/ownership.ts');
const { currentFamily, firstTierOf } = await import('../src/harness/family.ts');

test('a quote-reply becomes an annotation above the message', () => {
  const p = parseUserText('<!-- reply 1 -->\n> The cache is warmed on startup.\n\nCan we make that lazy?');
  assert.equal(p.text, 'Can we make that lazy?');
  assert.deepEqual(p.annotations, [{ text: 'The cache is warmed on startup.', annotation: undefined }]);
});

test('a CRLF quote-reply reads like an LF one and does not throw (#4242)', () => {
  const p = parseUserText('<!-- reply 1 -->\r\n> The cache is warmed.\r\n\r\nMake it lazy?');
  assert.equal(p.text, 'Make it lazy?');
  assert.deepEqual(p.annotations, [{ text: 'The cache is warmed.', annotation: undefined }]);
});

test('several quote-replies keep each comment with its quote', () => {
  const r = extractReplyQuotes(
    '<!-- reply 1 -->\n> first point\n\nagree\n\n<!-- reply 2 -->\n> second point\n> continues\n\nwhat about tests?',
  );
  assert.deepEqual(r?.annotations, [
    { text: 'first point', annotation: 'agree' },
    { text: 'second point\ncontinues', annotation: undefined },
  ]);
  assert.equal(r?.text, 'what about tests?');
});

test('a plain Markdown quote without a marker is left alone', () => {
  const p = parseUserText('> just a quote\n\nand a question');
  assert.equal(p.text, '> just a quote\n\nand a question');
  assert.equal(p.annotations.length, 0);
});

test('the hidden handoff block never shows in the message', () => {
  const p = parseUserText(
    '<sage-handoff from="Codex" mode="auto">\n## Conversation so far\n### Turn 1\nUser: hi\n</sage-handoff>\n\nWhat did we decide?',
  );
  assert.equal(p.text, 'What did we decide?');
});

test('Claude plan labels read like the product', () => {
  assert.equal(claudePlanLabel('Claude Max', 'claude_max', 'default_claude_max_20x'), 'Claude Max 20×');
  assert.equal(claudePlanLabel(null, 'claude_max', null), 'Claude Max');
  assert.equal(claudePlanLabel('pro'), 'Claude Pro');
  assert.equal(claudePlanLabel(null, null, null), null);
});

test('ownership comes from the segment record, never from an id spelling', () => {
  const id = claudeThreadId('1234-abcd');
  assert.equal(id, 'claude:1234-abcd');
  assert.equal(claudeSessionId(id), '1234-abcd');
  assert.equal(ownerOf(id), 'claude');
  // an id spelled like a Claude one but recorded as Codex is Codex
  noteOwner('claude:looks-claude', 'codex');
  assert.equal(ownerOf('claude:looks-claude'), 'codex');
  // no record: Codex, whatever the spelling
  assert.equal(ownerOf('claude:unrecorded'), 'codex');
  assert.equal(ownerOf('019a11f1-0000-7000-8000-000000000000'), 'codex');
  // a basic harness's segment is not Claude
  noteOwner('acp:kimi:s', 'acp:kimi');
  assert.equal(ownerOf('acp:kimi:s'), 'codex');
});

test('a switched chat is owned by its last segment, a single-segment chat by its recorded kind', () => {
  const seg = (harness: string, nativeId: string, start: number) =>
    ({ harness, nativeId, start, count: null, model: null, handoff: null }) as any;
  const segs = [seg('codex', 'chat-1', 0), seg('claude', 'claude:s-2', 2)];
  noteSegments(segs);
  assert.equal(currentFamily(segs, 'chat-1'), 'claude');
  assert.equal(currentFamily([segs[0], seg('codex', 'c3', 4)], 'chat-1'), 'codex');
  assert.equal(ownerOf('claude:s-2'), 'claude');
  assert.equal(ownerOf('chat-1'), 'codex');
  noteOwner('solo', 'claude');
  assert.equal(currentFamily(null, 'solo'), 'claude');
  assert.equal(currentFamily(undefined, 'unrecorded'), 'codex');
});

test("a basic harness's chat is its own family, never resolved to Codex", () => {
  const seg = (harness: string, nativeId: string, start: number) =>
    ({ harness, nativeId, start, count: null, model: null, handoff: null }) as any;
  // a basic chat on its own, and one whose current segment is a basic harness's session
  assert.equal(currentFamily(null, 'acp:kimi:1'), 'acp');
  assert.equal(currentFamily([seg('codex', 'chat-2', 0), seg('codex', 'acp:kimi:2', 3)], 'chat-2'), 'acp');
  // a segment kind this build doesn't know is not taken for Claude Code
  assert.equal(currentFamily([seg('gemini', 'chat-3', 0)], 'chat-3'), 'codex');
  // no first-tier harness for a basic chat: callers say what it does instead
  assert.deepEqual(
    ['codex', 'claude', 'acp'].map((f) => firstTierOf(f as never)),
    ['codex', 'claude', null],
  );
  // only a first-tier kind is recorded for a native session; a basic one or none leaves the record alone
  noteOwner('own', 'claude');
  noteOwner('own', 'acp:kimi');
  noteOwner('own', null);
  assert.equal(ownerOf('own'), 'claude');
});

test('editing only reaches turns inside the current segment', async () => {
  const { inCurrentSegment } = await import('../src/harness/types.ts');
  const seg = (start: number) => ({ harness: 'codex', nativeId: 'x', start, count: null, model: null, handoff: null }) as any;
  assert.equal(inCurrentSegment(null, 0), true);
  assert.equal(inCurrentSegment([seg(0), seg(3)], 2), false);
  assert.equal(inCurrentSegment([seg(0), seg(3)], 3), true);
  // switched but nothing sent yet: the last turn is still the earlier segment's
  assert.equal(inCurrentSegment([seg(0), seg(4)], 3), false);
});

test('only Codex chats show a pull request badge', async () => {
  const { hasThreadPullRequest } = await import('../src/harness/types.ts');
  noteOwner('pr-claude', 'claude');
  noteOwner('pr-codex', 'codex');
  assert.equal(hasThreadPullRequest('pr-codex'), true);
  assert.equal(hasThreadPullRequest('pr-claude'), false);
  assert.equal(hasThreadPullRequest('acp:gemini:pr'), false);
});
