// PR delivery tables must identify the same completed work as prose and lists without adopting historical citations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullRequestReplies, responsePullRequests } from '../src/lib/responsePullRequest.ts';

const a = 'https://github.com/mopilot-ai/mopilot-internal/pull/5333';
const b = 'https://github.com/mopilot-ai/mopilot-internal/pull/5334';
const table = `| PR | What | Merge commit |
| --- | --- | --- |
| [mopilot-ai/mopilot-internal#5333](${a}) | Codex sign-in on a remote machine | \`fd1256781\` |
| [mopilot-ai/mopilot-internal#5334](${b}) | One Run on picker | \`a1e675308\` |`;
const reply = (text: string) => ({ status: 'completed', items: [{ type: 'agentMessage', text, phase: 'final_answer' }] });
const found = (text: string) => responsePullRequests([reply(text)]).map((pr) => [pr.number, pr.state]);

test('the reported remote chat identifies both merged PRs delivered in a table, including from saved replies', () => {
  const text = `Both PRs are merged, and I confirmed each merge commit is in remote main.\n\n${table}`;
  assert.deepEqual(found(text), [
    [5334, 'merged'],
    [5333, 'merged'],
  ]);
  assert.deepEqual(responsePullRequests(pullRequestReplies([reply(text)])), responsePullRequests([reply(text)]));
});

test('opening several PRs in a table accepts short PR labels and bare URLs', () => {
  for (const label of ['PR #5333', '#5333', a]) {
    assert.deepEqual(found(`I opened two draft PRs.\n\n${table.replace('mopilot-ai/mopilot-internal#5333', label)}`), [
      [5334, 'draft'],
      [5333, 'draft'],
    ]);
  }
});

test('a table preserves citation, count, question and conditional ownership guards', () => {
  for (const text of [
    `Related historical changes:\n\n${table}`,
    `If both PRs are merged, the work is done.\n\n${table}`,
    `Both PRs are merged?\n\n${table}`,
    `Example reply:\n\nBoth PRs are merged.\n\n${table}`,
    `I opened three PRs.\n\n${table}`,
    `Both PRs are merged.\n\n${table}\n\nFor background see https://github.com/other/repo/pull/99.`,
    `Both PRs are merged.\n\n${table.replace('One Run on picker', 'If checks pass')}`,
    `Both PRs are merged.\n\n${table.replace('[mopilot-ai/mopilot-internal#5333]', '[Earlier implementation]')}`,
    `Both PRs are merged.\n\n\`\`\`markdown\n${table}\n\`\`\``,
    `Both PRs are merged.\n\n${table
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}`,
  ])
    assert.deepEqual(found(text), [], text);
});

test('a delivery row cannot adopt historical citations in another cell or beside its PR reference', () => {
  for (const row of [
    `| [PR #5333](${a}) | Historical implementation: [Earlier PR](${b}) |`,
    `| [PR #5333](${a}) and [Earlier PR](${b}) | Remote work |`,
  ]) {
    assert.deepEqual(found(`Both PRs are merged.\n\n| PR | Notes |\n| --- | --- |\n${row}`), []);
  }
});
