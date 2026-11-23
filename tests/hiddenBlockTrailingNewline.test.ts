// The blocks the app puts ahead of a user's words for the agent alone stay hidden when the message holds nothing after them
// (an image-only message) and the stored text lost its trailing newline or came back with CRLF line ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUserText, withoutHiddenBlocks } from '../shared/userText.mjs';
import { withRosterBlock, withoutRosterBlock } from '../shared/sideSessions.mjs';
import { withChatReferences } from '../shared/chatReferences.mjs';
import { browserHandoffMessage } from '../shared/chromeHandoff.mjs';
import { withMomoContext } from '../shared/momoContext.mjs';
import { withComputerHistory } from '../shared/computerHistory.mjs';
import { userContent } from './support/claude-translate.ts';

const BLOCKS: Record<string, string> = {
  'sage-chat-context': '<sage-chat-context>\nsnapshots\n</sage-chat-context>',
  'sage-computer-history': '<sage-computer-history>\nentries\n</sage-computer-history>',
  'momo-context': '<momo-context>\nfacts\n</momo-context>',
  'sage-browser-handoff': '<sage-browser-handoff>\nroute\n</sage-browser-handoff>',
  'sage-linked-sessions': '<sage-linked-sessions>\nLinked sessions now: a = b (working).\n</sage-linked-sessions>',
  'sage-routine-hint': '<sage-routine-hint>\nA saved routine did this request before.\n</sage-routine-hint>',
};

// the blocks as their own producers write them, with no user text after
const produced: Record<string, string> = {
  'sage-chat-context': withChatReferences('', [{ kind: 'session', path: 'c1', name: 'Chat', text: 'hi' }]),
  'sage-computer-history': withComputerHistory('', [{ kind: 'computerHistory', text: BLOCKS['sage-computer-history'] }]),
  'momo-context': withMomoContext('', BLOCKS['momo-context']),
  'sage-browser-handoff': browserHandoffMessage('route note', ''),
  'sage-linked-sessions': withRosterBlock('', 'Linked sessions now: a = b (working).'),
};

for (const [tag, block] of Object.entries(BLOCKS)) {
  test(`${tag} is hidden with text after it, with nothing after it, trimmed, and with CRLF`, () => {
    assert.equal(withoutHiddenBlocks(`${block}\nhello`), 'hello');
    assert.equal(withoutHiddenBlocks(`${block}\n`), '');
    assert.equal(withoutHiddenBlocks(block), '');
    assert.equal(withoutHiddenBlocks(block.replace(/\n/g, '\r\n')), '');
    assert.equal(withoutHiddenBlocks(`${block.replace(/\n/g, '\r\n')}\r\nhello`), 'hello');
    assert.equal(parseUserText(block).text, '');
  });
}

for (const [tag, text] of Object.entries(produced)) {
  test(`${tag} as its producer writes it is hidden when nothing follows, even trimmed`, () => {
    assert.ok(text.startsWith(`<${tag}>`));
    assert.equal(withoutHiddenBlocks(text), '');
    assert.equal(withoutHiddenBlocks(text.trimEnd()), '');
    assert.equal(withoutHiddenBlocks(`${text}typed`), 'typed');
  });
}

test('the handoff block and a block chained ahead of another are hidden when nothing follows', () => {
  const handoff = '<sage-handoff from="Codex" mode="full">\nbody\n</sage-handoff>';
  assert.equal(withoutHiddenBlocks(handoff), '');
  assert.equal(withoutHiddenBlocks(`${handoff}\n${BLOCKS['sage-linked-sessions']}`), '');
});

test('a block the user typed mid-message is not hidden', () => {
  const typed = `say ${BLOCKS['momo-context']}`;
  assert.equal(withoutHiddenBlocks(typed), typed);
  assert.equal(withoutHiddenBlocks('<momo-context>\nunclosed'), '<momo-context>\nunclosed');
});

test('the roster block is removed from a trimmed or CRLF message too, so it is never added twice', () => {
  const only = withRosterBlock('', 'R1').trimEnd();
  assert.equal(withoutRosterBlock(only), '');
  assert.equal(withoutRosterBlock(withRosterBlock('hi', 'R1').replace(/\n/g, '\r\n')), 'hi');
  assert.equal(withRosterBlock(only, 'R2'), '<sage-linked-sessions>\nR2\n</sage-linked-sessions>\n');
});

test('a replayed Claude Code prompt that is only a block (an image-only message) shows no text, though replay trims it', () => {
  const only = withRosterBlock('', 'Linked sessions now: a = b (working).');
  const [replayed] = userContent([
    { type: 'text', text: only },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
  ]);
  assert.equal(replayed.text.endsWith('</sage-linked-sessions>'), true);
  assert.equal(withoutHiddenBlocks(replayed.text), '');
  assert.equal(parseUserText(replayed.text).text, '');
});
