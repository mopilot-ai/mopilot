// shared/proseLinks.mjs: a link written in prose ends before a bracket or quote around it and the punctuation after it,
// for every reader of links in prose (a chat's PR, a sign-in's links, claude.ai links, the summary's sources, handoffs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proseLinks, splitLinks, trimLink } from '../shared/proseLinks.mjs';
import { findClaudeUrl } from '../shared/claudeArtifacts.mjs';
import { builtinHandoff } from '../src/lib/agentNarration/handoffs.ts';
import { MOVED_PREFIX } from '../shared/chromeHandoff.mjs';

test('a link in brackets, quotes or backticks, or before sentence punctuation, is the link alone', () => {
  assert.deepEqual(
    proseLinks(
      'See (https://a.test/x), [https://b.test/y]. "https://c.test/z" `https://d.test/w` <https://e.test/v>; http://f.test/u?q=1!',
    ),
    ['https://a.test/x', 'https://b.test/y', 'https://c.test/z', 'https://d.test/w', 'https://e.test/v', 'http://f.test/u?q=1'],
  );
  assert.deepEqual(proseLinks('no links here'), []);
  assert.equal(trimLink('https://a.test/x.,;:!?'), 'https://a.test/x');
});

test("a claude.ai link inside another site's address is not a claude.ai link", () => {
  assert.equal(findClaudeUrl('https://evil.test/https://claude.ai/artifact/abcd1234'), null);
  assert.equal(findClaudeUrl('Published (https://claude.ai/artifact/abcd1234).')?.url, 'https://claude.ai/artifact/abcd1234');
});

test("a sign-in moved to Chrome names the page without the sentence's period", () => {
  const handoff = builtinHandoff('request_signin', {}, `${MOVED_PREFIX}. Continue at https://login.test/start.`);
  assert.equal(handoff?.url, 'https://login.test/start');
});

test('splitLinks cuts text around its links, the punctuation after a link kept in the text', () => {
  assert.deepEqual(splitLinks('Open https://x.test/a. Then (https://y.test/b)!'), [
    'Open ',
    'https://x.test/a',
    '. Then (',
    'https://y.test/b',
    ')!',
  ]);
  assert.deepEqual(splitLinks('plain'), ['plain']);
  assert.deepEqual(splitLinks('https://x.test'), ['', 'https://x.test', '']);
});
