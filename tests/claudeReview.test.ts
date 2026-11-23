// What an existing Claude Code chat is sent for a review (src/lib/claudeReview.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeReviewMessage, claudeReviewPrompt, reviewArgs } from '../src/lib/claudeReview.ts';

test("a harness's own /review takes no arguments for the working tree, the instructions, or the plain-words ask", () => {
  assert.equal(reviewArgs(null), '');
  assert.equal(reviewArgs({ type: 'uncommittedChanges' }), '');
  assert.equal(reviewArgs({ type: 'custom', instructions: 'auth only' }), 'auth only');
  assert.equal(reviewArgs({ type: 'custom' }), '');
  assert.match(reviewArgs({ type: 'baseBranch', branch: 'main' }), /against main/);
});

test('uncommitted changes and /review arguments go to the CLI as /code-review', () => {
  assert.equal(claudeReviewMessage({ type: 'uncommittedChanges' }), '/code-review');
  assert.equal(claudeReviewMessage({ type: 'custom', instructions: 'high' }), '/code-review high');
});

test('other targets are plain words naming the base branch or commit', () => {
  assert.match(claudeReviewMessage({ type: 'baseBranch', branch: 'main' }), /against main.*main\.\.\.HEAD/);
  assert.match(claudeReviewPrompt({ type: 'commit', sha: 'abc123', title: 'Fix' }), /commit abc123 \(Fix\)/);
});
