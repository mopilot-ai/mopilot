// The replies a chat keeps for its PR badge: only those that link a PR, mention a PR number or report a state, and
// responsePullRequest finds the same PR from them as from the whole history, with or without a known URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullRequestReplies, responsePullRequest } from '../src/lib/responsePullRequest.ts';

const url = 'https://github.com/org/repo/pull/42';
const other = 'https://github.com/org/repo/pull/43';
const reply = (text: string, phase: string | null = 'final_answer') => ({ type: 'agentMessage', text, phase });
const turn = (items: object[], status = 'completed') => ({ status, items });

const history = [
  turn([reply('Looking at the failing test now.', 'commentary'), reply('Fixed the parser and added a test.')]),
  turn([{ type: 'commandExecution', text: `gh pr view ${url}` }, reply(`Opened [PR #42](${url}).`)]),
  turn([reply('Rebased on main; all 14 tests pass.')]),
  turn([reply('It is labeled merge-on-green, not merged yet.')]),
  turn([reply('Unrelated: renamed the helper.')], 'interrupted'),
  turn([reply('PR #43 needs a look too.')]),
  turn([reply(`Merged [PR #42](${url}) into main.`)]),
  turn([reply(''), null as unknown as object, reply('Merged.')]),
  turn([reply(`Compare ${url} and ${other}.`)]),
];

test('only replies that can change the result are kept, in order, from completed turns', () => {
  const kept = pullRequestReplies(history as any);
  assert.deepEqual(
    kept.map((t) => t.items.map((i) => i.text)),
    [
      [`Opened [PR #42](${url}).`],
      ['It is labeled merge-on-green, not merged yet.'],
      ['PR #43 needs a look too.'],
      [`Merged [PR #42](${url}) into main.`],
      ['Merged.'],
      [`Compare ${url} and ${other}.`],
    ],
  );
  assert.deepEqual(pullRequestReplies(null as any), []);
  assert.deepEqual(pullRequestReplies([turn([reply('Nothing about a PR here.')])] as any), []);
});

test('the kept replies give the same PR as the whole history, for every prefix and known URL', () => {
  for (let n = 0; n <= history.length; n++) {
    const turns = history.slice(0, n) as any;
    for (const known of [undefined, null, url, other, 'https://example.com/x'])
      assert.deepEqual(responsePullRequest(pullRequestReplies(turns), known), responsePullRequest(turns, known), `${n} turns, ${known}`);
  }
});
