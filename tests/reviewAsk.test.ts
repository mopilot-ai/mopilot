// A review ask's words, shared by the review menus and main: which prompts ask for a review whose reply holds findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeReviewPrompt, isReviewAsk } from '../shared/reviewAsk.mjs';

test('every review menu prompt is a review ask, and so are the review commands a harness runs here', () => {
  for (const target of [
    { type: 'baseBranch', branch: 'main' },
    { type: 'commit', sha: 'abc123', title: 'Fix div' },
    { type: 'commit', sha: 'abc123' },
    { type: 'custom', instructions: 'Focus on the parser.' },
    { type: 'custom' },
  ])
    assert.equal(isReviewAsk(claudeReviewPrompt(target)), true, target.type);
  for (const prompt of ['/code-review', ' /code-review high --fix', '/review the parser', '/security-review'])
    assert.equal(isReviewAsk(prompt), true, prompt);
});

test('a cloud review, a lookalike command, other words and no text are not review asks', () => {
  for (const prompt of [
    '/ultrareview',
    '/ultrareview 12',
    '/code-review ultra',
    '/code-review --comment ultra',
    '/code-reviewer',
    '/reviews',
    'please review this',
    '',
    null,
    7,
  ])
    assert.equal(isReviewAsk(prompt), false, String(prompt));
});
