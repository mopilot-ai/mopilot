// Delivery reports that say the PR merged into the remote's default branch, or put its link after a colon, or say the work was pushed as a PR, identify the chat's PR: the sidebar badge goes by them when no branch lookup can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responsePullRequests, type ResponseTurn } from '../src/lib/responsePullRequest.ts';

const URL = 'https://github.com/mopilot-ai/mopilot-internal/pull/5700';
const turn = (...texts: string[]): ResponseTurn => ({ status: 'completed', items: texts.map((text) => ({ type: 'agentMessage', text })) });
const found = (...turns: ResponseTurn[]) => responsePullRequests(turns).map((pr) => [pr.url, pr.state]);

test("the replies of #5700's chat report it opened, then merged into remote main", () => {
  const opened = turn(
    `Committed and pushed as PR #5700: ${URL}. It isn't merged yet. Two things are still running:\n\n- **CI:** the required checks were queued.`,
  );
  const merged = turn(
    `PR #5700 is merged into remote main: ${URL}. Its merge commit, \`9128f008b\`, is on main.\n\n- **CI:** \`unit-tests\` passed.`,
  );
  assert.deepEqual(found(opened), [[URL, 'open']]);
  assert.deepEqual(found(merged), [[URL, 'merged']]);
  assert.deepEqual(found(opened, merged), [[URL, 'merged']]);
});

test('a merge into the default branch counts however the reply names it, and its link may follow a colon', () => {
  for (const text of [
    `PR #5700 is merged into main: ${URL}.`,
    `PR #5700 was merged into origin/main: ${URL}.`,
    `Merged into the remote master: ${URL}.`,
    `[PR #5700](${URL}) has been merged into remote main.`,
  ])
    assert.deepEqual(found(turn(text)), [[URL, 'merged']], text);
});

test('work pushed as a draft PR is a draft, and pushed as a PR is open', () => {
  assert.deepEqual(found(turn(`Pushed it as a draft PR: ${URL}.`)), [[URL, 'draft']]);
  assert.deepEqual(found(turn(`Opened as PR #5700: ${URL}.`)), [[URL, 'open']]);
});

test('a merge into another branch, a conditional merge and a question still report nothing', () => {
  for (const text of [
    `PR #5700 is merged into remote staging: ${URL}.`,
    `If PR #5700 is merged into remote main: ${URL}.`,
    `Was PR #5700 merged into remote main? ${URL}`,
    `Should it be pushed as a PR: ${URL}?`,
  ])
    assert.deepEqual(found(turn(text)), [], text);
});

test('a merge label before its link reports the merge; work not yet pushed as a PR, or pushed as a PR comment, reports nothing', () => {
  for (const text of [`Merged: ${URL}`, `**Merged:** ${URL}`, `Merged into main:\n\n- ${URL}`])
    assert.deepEqual(found(turn(text)), [[URL, 'merged']], text);
  for (const text of [
    `I haven't pushed it as a PR yet: ${URL}.`,
    `It was not opened as a PR: ${URL}.`,
    `Pushed as a PR comment: ${URL}.`,
    `Opened as a PR review: ${URL}.`,
  ])
    assert.deepEqual(found(turn(text)), [], text);
});
