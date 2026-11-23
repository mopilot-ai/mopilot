// A reply that reports several PRs at once ("I've opened two PRs" with their links, "Both PRs are merged" naming #N)
// makes each of them the chat's PR, so a chat whose worktree is gone still shows them; a reply that only cites PRs doesn't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullRequestReplies, responsePullRequests } from '../src/lib/responsePullRequest.ts';

const a = 'https://github.com/org/repo/pull/1649';
const b = 'https://github.com/org/repo/pull/1650';
const c = 'https://github.com/org/repo/pull/1581';
const turn = (text: string) => ({ status: 'completed', items: [{ type: 'agentMessage', text, phase: 'final_answer' }] });
const found = (...texts: string[]) => responsePullRequests(texts.map(turn)).map((p) => [p.number, p.state]);

// the replies of the chat that opened and merged #1649 and #1650 (#1581 is one it only cited)
const chat = [
  `I've opened two PRs. Neither is merged, and I haven't tried either in the real app.\n\n**1. The real reason: [#1649](${a})**\n- MoPilot refused tool calls.\n\n**2. Native plans: [#1650](${b})**\n- Shows each harness's plan, as [#1581](${c}) did for badges.`,
  '#1649 is waiting on a fresh check against the new main. Labelling both PRs `merge-on-green`.',
  'Neither PR is merged yet. Main moved after their first checks.\n\n- **#1649** is labelled `merge-on-green`.\n- **#1650** is labelled the same way.',
  'Both PRs are merged, and both merge commits are in the remote main.\n\n- **#1649**, the fix: merge commit `8d4422b4`.\n- **#1650**, the plans: merge commit `8ad1b598`.',
];

test("the chat's two PRs are found from its replies, merged, with the cited one left out", () => {
  // three links where the reply says two: the cited one makes it ambiguous, as before
  assert.deepEqual(found(chat[0]), []);
  const opened = chat[0].replace(`, as [#1581](${c}) did for badges`, '');
  assert.deepEqual(found(opened), [
    [1650, 'open'],
    [1649, 'open'],
  ]);
  assert.deepEqual(found(opened, ...chat.slice(1, 3)), [
    [1650, 'open'],
    [1649, 'open'],
  ]);
  assert.deepEqual(found(opened, ...chat.slice(1)), [
    [1650, 'merged'],
    [1649, 'merged'],
  ]);
  // the saved replies keep every one that bears on them, and find the same
  const kept = pullRequestReplies([opened, ...chat.slice(1)].map(turn));
  assert.equal(kept.length, 3);
  assert.deepEqual(
    responsePullRequests(kept).map((p) => p.state),
    ['merged', 'merged'],
  );
});

for (const [text, expected] of [
  [
    `We have created two draft PRs: ${a} and ${b}.`,
    [
      [1650, 'draft'],
      [1649, 'draft'],
    ],
  ],
  [
    `I created 2 pull requests: ${a}, ${b}.`,
    [
      [1650, 'open'],
      [1649, 'open'],
    ],
  ],
  [
    `All PRs were merged: ${a}, ${b}, ${c}.`,
    [
      [1581, 'merged'],
      [1650, 'merged'],
      [1649, 'merged'],
    ],
  ],
  [
    `All three of the PRs have been merged. ${a} ${b} ${c}`,
    [
      [1581, 'merged'],
      [1650, 'merged'],
      [1649, 'merged'],
    ],
  ],
  [
    `I merged both PRs. ${a} ${b}`,
    [
      [1650, 'merged'],
      [1649, 'merged'],
    ],
  ],
  [
    `We merged all the pull requests. ${a} ${b}`,
    [
      [1650, 'merged'],
      [1649, 'merged'],
    ],
  ],
  [`I've opened three PRs. ${a} ${b}`, []],
  [`Compare ${a} and ${b}.`, []],
  [`If both PRs are merged, ${a} and ${b} close the issue.`, []],
  [`Both PRs are merged? ${a} ${b}`, []],
  [`Example reply:\n\nBoth PRs are merged. ${a} ${b}`, []],
  [`Both PRs are merged. ${a}`, []],
] as const) {
  test(`${expected.length ? expected[0][1] : 'none'}: ${text.split('\n')[0]}`, () => {
    assert.deepEqual(found(text), expected);
  });
}

test('#N names only PRs the chat already found; a reply naming one of them, or none, changes nothing', () => {
  const opened = `I've opened two PRs: ${a} and ${b}.`;
  assert.deepEqual(found('Both PRs are merged: #1649 and #1650.'), []);
  // one known PR: not several
  assert.deepEqual(found(opened, 'Both PRs are merged: #1649 and #77.'), [
    [1650, 'open'],
    [1649, 'open'],
  ]);
  // an issue number beside them is not one of the chat's PRs
  assert.deepEqual(found(opened, 'Both PRs are merged (#1649, #1650), closing #12.'), [
    [1650, 'merged'],
    [1649, 'merged'],
  ]);
  // a link fragment or an HTML entity is not a #N
  assert.deepEqual(found(opened, 'Both PRs are merged: see org/repo#1649 and &#1650.'), [
    [1650, 'open'],
    [1649, 'open'],
  ]);
});

test('a plural reply may link some of the PRs and name the others as #N; opening PRs in passing is not this chat opening them', () => {
  const opened = `I've opened two PRs: ${a} and ${b}.`;
  assert.deepEqual(found(opened, `Both PRs are merged: [#1649](${a}) and #1650.`), [
    [1650, 'merged'],
    [1649, 'merged'],
  ]);
  assert.deepEqual(found(`Earlier today we opened two PRs upstream, see ${a} and ${b}.`), []);
});
