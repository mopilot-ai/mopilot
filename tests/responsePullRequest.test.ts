// Completed assistant reports identify PRs without treating plans, negations or examples as merged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responsePullRequest, responsePullRequests } from '../src/lib/responsePullRequest.ts';
const url = 'https://github.com/org/repo/pull/42';
const report = (text: string, status = 'completed', type = 'agentMessage', phase: string | null = 'final_answer') => ({
  status,
  items: [{ type, text, phase }],
});

test('the screenshot reports a queued PR as open, never merged', () => {
  assert.deepEqual(
    responsePullRequest([
      report(
        `Committed as 5e412e76 and opened [PR #42](${url}).\n\nAll 14 focused tests pass. The PR is labeled **merge-on-green**, not merged yet: CI is running. It will merge automatically when the gate allows.`,
      ),
    ]),
    { url, number: 42, state: 'open', source: 'response' },
  );
});

for (const [text, state] of [
  [`Merged [PR #42](${url}) into main.`, 'merged'],
  [`Merged [ORG/REPO#42](${url}) into main.`, 'merged'],
  [`Merged [org/repo#42](${url}) and verified commit \`abc123\` is on remote \`main\`.`, 'merged'],
  [`Merged [org/repo#42](${url}) and verified commit \`abc123\` is on remote \`release/when-ready\`.`, 'merged'],
  [`Merged [org/repo#42](${url}) and verified commit \`abc123\` is on main (see [PR #42](${url}?tab=files)).`, 'merged'],
  [`Merged [org/repo#42](${url}) and verified commit \`abc123\` is on main (see [pull request #42](${url})).`, 'merged'],
  [`Merged [org/repo#42](${url}) into main and verified commit abc123 is on origin/main (see [org/repo#42](${url})).`, 'merged'],
  [`Merged [PR #42](${url}) and confirmed the merge commit is in main.`, 'merged'],
  [`Merged [#42](${url}) and verified commit \`abc123\` is on remote \`main\`.`, 'merged'],
  [`Merged ${url} and verified commit \`abc123\` is on remote \`main\`.`, 'merged'],
  [`Merged [PR #42](${url}) into remote \`main\`.`, 'merged'],
  [`CI finally passed... Merged [PR #42](${url}).`, 'merged'],
  [`I merged [PR #42](${url}) into \`release/when-ready\` and confirmed it contains merge commit fda931.`, 'merged'],
  [
    `Merged [PR #42](${url}) into remote \`main\` and verified that it contains fix commit \`e9cb0bd\` and merge commit \`db81efa\`.`,
    'merged',
  ],
  [`Committed and merged [PR #42](${url}).`, 'merged'],
  [`I have successfully merged [PR #42](${url}).`, 'merged'],
  [`The pull request #42 has been successfully merged. ${url}`, 'merged'],
  [`PR #42 merged. ${url}`, 'merged'],
  [`PR #42 was closed. ${url}`, 'closed'],
  [`Closed pull request #42. ${url}`, 'closed'],
  [`Opened [PR #42](${url})…`, 'open'],
  [`Created a draft PR #42. ${url}`, 'draft'],
  [`The PR #42 is a draft. ${url}`, 'draft'],
  [`Reopened PR #42. ${url}`, 'open'],
  [`PR #42 is open. ${url}`, 'open'],
  [`The PR #42 is not yet merged. ${url}`, 'open'],
  [`PR #42 is queued as merge-on-green. ${url}`, 'open'],
  [`PR #42 will merge automatically. ${url}`, 'open'],
  [`Waiting to merge PR #42. ${url}`, 'open'],
  [`[PR #42](${url})`, 'unknown'],
  [`[PR #42](${url}) is merged when CI passes.`, 'unknown'],
  [`Merged [PR #42](${url})?`, 'unknown'],
  [`Merged [PR #42](${url}) into remote \`main\` and verified it contains commit \`abc123\`?`, 'unknown'],
  [`Merged [PR #42](${url}) into main and verified that it contains fix commit \`not-a-hash\`.`, 'unknown'],
  [`Merged [PR #42](${url}) into main and verified that it contains fix commit \`abc123\`. Correction: No merge was performed.`, 'unknown'],
  [`Merged [PR #42](${url}) into main and verified that it contains fix commit \`abc123\`, but the PR is still open.`, 'unknown'],
  [`Merged into main and verified that it contains commit \`abc123\` from [PR #42](${url}).`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit \`abc123\` is on remote \`main\`?`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit \`abc123\` is on remote \`main\` (right?).`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on remote main (right?) — just checking.`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on remote main — dry run only, no merge was performed.`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main; this was only a dry run and no merge was performed.`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit \`abc123\` is on remote ~~main~~.`, 'unknown'],
  [`Merged [org/repo#42](${url}) and \`verified\` commit \`abc123\` is on remote \`main\`.`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit \`abc123\` is on remote \`main (dry run only; no merge performed)\`.`, 'unknown'],
  [
    `Merged [org/repo#42](${url}) and verified commit abc123 is on remote main, but the PR is still open; the commit landed separately.`,
    'unknown',
  ],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is not on main.`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main (see [#43](${url})).`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main (compare [PR #42](${url})).`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main (see [PR #42](${url}) for context).`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main (see [PR #42](${url}))?`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main (see [org/other#42](${url})).`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main (see #43).`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main (see org/other#42).`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main (see [#42](https://github.com/org/other/issues/42)).`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main. Correction: No merge was performed.`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main. Actually, no merge was performed.`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main. Correction: I did not merge the PR.`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit abc123 is on main. Correction: I did not merge PR #42.`, 'unknown'],
  [`Merged [org/repo#42](${url}) into main. Correction: No merge was performed.`, 'unknown'],
  [`Merged [PR #42](${url}). No merge was performed manually; the merge queue handled it.`, 'merged'],
  [`Merged [PR #42](${url}). No merge was performed for the other PR.`, 'merged'],
  [`Merged [PR #42](${url}). No merge was performed?`, 'merged'],
  [`Merged [org/other#42](${url}) and verified commit \`abc123\` is on remote \`main\`.`, 'unknown'],
  [`Merged [org/repo#43](${url}) and verified commit \`abc123\` is on remote \`main\`.`, 'unknown'],
  [`Merged [org/repo#42](${url}) and verified commit history in [org/other#42](https://github.com/org/other/pull/42).`, 'unknown'],
  [`Merged origin/main and verified commit \`abc123\` mentioned in [org/repo#42](${url}).`, 'unknown'],
  [`Merged PR #42 and verified commit history in [org/other#42](https://github.com/org/other/pull/42).`, 'unknown'],
  [`I should have merged [PR #42](${url}).`, 'unknown'],
  [`Merged origin/main into topic. ${url}`, 'unknown'],
  [`The response says "merged". ${url}`, 'unknown'],
  [`Do not claim merged. ${url}`, 'unknown'],
  [`Expected response after CI:\n\nMerged PR #42.\n\n${url}`, 'unknown'],
  [`Example reply:\n\nPR #42 is merged. ${url}`, 'unknown'],
  [`Response template:\n\nMerged PR #42. ${url}`, 'unknown'],
  [`After CI passes I will reply:\n\nMerged PR #42. ${url}`, 'unknown'],
  [`[PR #42](${url})\n\n---`, 'unknown'],
  [`PR #42 is not\nmerged. ${url}`, 'open'],
  [`PR #42 will be\nmerged. ${url}`, 'unknown'],
  [`PR #42 is merged. That statement is false; it is still open. ${url}`, 'open'],
  [`PR #42 is not  \nmerged. ${url}`, 'open'],
  [`PR #42 is merged only after CI passes. ${url}`, 'unknown'],
  [`Merged PR #42 is the message I will send after CI passes. ${url}`, 'unknown'],
  [`PR #42 is merged, but that was a mistake in my previous reply; it remains open. ${url}`, 'open'],
  [`PR #42 is \`not\` merged. ${url}`, 'unknown'],
  [`PR #42 is\n\n> not\n\nmerged. ${url}`, 'unknown'],
  [`[PR #42](${url})\n\n> PR #42 is merged.`, 'unknown'],
  [`[PR #42](${url})\n\n\`PR #42 is merged\``, 'unknown'],
  [`[PR #42](${url})\n\n\`\`\`\nPR #42 is merged.\n\`\`\``, 'unknown'],
  [`[PR #42](${url})\n\n    PR #42 is merged.`, 'unknown'],
  [`[PR #42](${url})\n\n<!-- PR #42 is merged. -->`, 'unknown'],
] as const) {
  test(`${state}: ${text.split('\n')[0]}`, () => {
    assert.deepEqual(responsePullRequest([report(text)]), state === 'unknown' ? null : { url, number: 42, state, source: 'response' });
  });
}

test('completed prose survives formatting, list structure, null phase and canonical URL variants', () => {
  for (const text of [
    `- **Merged** [PR #42](${url.replace('org/repo', 'ORG/REPO')}/?tab=files#top) into main.`,
    `## Merged PR #42\n\n${url}.`,
    `Merged pull request #42 into main. ${url};`,
  ])
    assert.equal(responsePullRequest([report(text, 'completed', 'agentMessage', null)])?.state, 'merged');
});

test('only complete assistant reports count; malformed boundaries and example-only links are ignored', () => {
  for (const turns of [
    null,
    {},
    [null],
    [{ status: 'completed' }],
    [{ status: 'completed', items: [null, {}, { type: 'agentMessage', text: 1 }] }],
    [report(`Merged PR #42. ${url}`, 'inProgress')],
    [report(`Merged PR #42. ${url}`, 'failed')],
    [report(`Merged PR #42. ${url}`, 'completed', 'userMessage')],
    [report(`Merged PR #42. ${url}`, 'completed', 'commandExecution')],
    [report(`Merged PR #42. ${url}`, 'completed', 'agentMessage', 'commentary')],
    [report('', 'completed')],
    [report('Merged PR #42.')],
    [report(`> Merged PR #42. ${url}`)],
    [report(`![Merged PR #42](${url})`)],
    [report(`\`\`\`\nMerged PR #42. ${url}\n\`\`\``)],
    [report('Merged PR #42. https://github.com.evil.test/org/repo/pull/42')],
  ])
    assert.equal(responsePullRequest(turns as any), null);
});

test('newer completed reports replace earlier status and can refer back to the same identified PR', () => {
  const turns = [report(`Opened [PR #42](${url}).`), report('Merged into main.')];
  assert.equal(responsePullRequest(turns)?.state, 'merged');
  turns.push(report('The PR is not merged yet.'));
  assert.equal(responsePullRequest(turns)?.state, 'open');
  turns.push(report('Tests passed.'));
  assert.equal(responsePullRequest(turns)?.state, 'open');
  assert.equal(responsePullRequest([report('Merged.')], url)?.state, 'merged');
  assert.equal(responsePullRequest([report('PR #42 is merged.')], 'not a url'), null);
});

test('a numbered correction withdraws only the merge it names', () => {
  const opened = report(`Opened [PR #42](${url}).`);
  const merge = `Merged [org/repo#42](${url}) and verified commit abc123 is on main.`;
  assert.equal(responsePullRequest([opened, report(`${merge} Correction: I did not merge PR #42.`)])?.state, 'open');
  assert.equal(responsePullRequest([opened, report(`${merge} Correction: I did not merge PR \`#42\`.`)])?.state, 'open');
  assert.equal(responsePullRequest([opened, report(`${merge} Correction: I did not merge PR #43.`)])?.state, 'merged');
  assert.equal(responsePullRequest([opened, report(`${merge} Correction: I did not merge PR #42; the queue did.`)])?.state, 'merged');
  assert.equal(
    responsePullRequest([opened, report(`${merge} Correction: I did not merge PR #42 because the queue did.`)])?.state,
    'merged',
  );
  assert.equal(responsePullRequest([opened, report(`${merge}\n\n[PR #42](${url})\n\nCorrection: I did not merge PR #42.`)])?.state, 'open');
});

test('a withdrawn merge link still identifies the PR named by a later open status', () => {
  const other = 'https://github.com/org/other/pull/42';
  const turns = [
    report(`Merged [PR #42](${url}).`),
    report(`Merged [org/other#42](${other}) and verified commit abc123 is on main. Correction: I did not merge PR #42. It is still open.`),
  ];
  assert.deepEqual(
    responsePullRequests(turns).map(({ url, state }) => [url, state]),
    [
      [other, 'open'],
      [url, 'merged'],
    ],
  );
});

test('a qualified or retracted cloud merge cannot establish or overwrite a PR status', () => {
  const merged = `Merged [PR #42](${url}) into remote \`main\``;
  const opened = report(`Opened [PR #42](${url}).`);
  for (const text of [
    `${merged}... if CI passes.`,
    `${merged}...\n\nOnly if CI passes.`,
    `${merged} (<https://example.com/status>?)`,
    `${merged} and verified it contains commit abc123. Correction: No merge was performed because CI failed.`,
    `${merged} and verified it contains commit abc123. Correction: No merge was performed because CI failed; checks timed out.`,
    `${merged} and verified it contains commit abc123. But only in a dry run.`,
    `${merged} and verified it contains commit abc123. But only in a dry run; nothing reached GitHub.`,
    `If CI passes:\n\n- ${merged} and verified it contains commit abc123.\n- ${merged}.`,
    `CI is pending. If CI passes:\n\n- ${merged} and verified it contains commit abc123.`,
    `CI is pending. Only if ci.yml passes:\n\n- ${merged} and verified it contains commit abc123.`,
    `CI is pending. Only if CI passes (e.g. after a retry):\n\n- ${merged} and verified it contains commit abc123.`,
    `Only if CI passes e.g. after a retry:\n\n- ${merged} and verified it contains commit abc123.`,
    `Only if CI passes (all required checks green!) proceed as follows:\n\n- ${merged} and verified it contains commit abc123.`,
    `Only if CI passes... proceed as follows:\n\n- ${merged} and verified it contains commit abc123.`,
    `Only if CI passes:\n\n---\n\n- ${merged} and verified it contains commit abc123.`,
    `### Unless CI fails:\n\n${merged}.`,
    `Merged [PR #42](${url}) into when.`,
  ]) {
    assert.equal(responsePullRequest([report(text)]), null, text);
    assert.equal(responsePullRequest([opened, report(text)])?.state, 'open', text);
  }
});

test('a condition on one Markdown block leaves a later explicit merge report intact', () => {
  const text = `If CI passes:\n\n- Wait for the merge gate.\n\nCI passed. Merged [PR #42](${url}) into remote \`main\`.`;
  assert.equal(responsePullRequest([report(text)])?.state, 'merged');
});

test('an earlier conditional sentence does not govern a separate result in the same paragraph', () => {
  for (const leadIn of ['stop. Actual result', 'stop. actual result', 'stop... actual result', 'stop… ✅ Actual result']) {
    const text = `If CI fails, ${leadIn}:\n\n- Merged [PR #42](${url}) into remote \`main\`.`;
    assert.equal(responsePullRequest([report(text)])?.state, 'merged');
  }
});

test('a condition on a delivery block cannot report that multiple PRs merged', () => {
  const links = `- [PR #42](${url})\n- [PR #43](https://github.com/org/repo/pull/43)`;
  const opened = report(`I've opened two PRs.\n\n${links}`);
  const conditional = report(`If CI passes:\n\n- Both PRs are merged.\n${links}`);
  assert.deepEqual(
    responsePullRequests([opened, conditional]).map((pr) => pr.state),
    ['open', 'open'],
  );
});

test('multiple PRs and mismatched short references cannot change another PR status', () => {
  assert.equal(responsePullRequest([report(`Merged [PR #42](${url}), see [PR #43](${url.replace('42', '43')}).`)]), null);
  assert.equal(responsePullRequest([report('PR #43 is merged.')], url), null);
  assert.equal(responsePullRequest([report(`Merged PR #43. ${url}`)]), null);
  assert.equal(responsePullRequest([report(`[PR #42](${url}) and ${url}:\n\nPR #42 is merged.`)])?.state, 'merged');
});

test('a different or ambiguous PR reference retires implicit identity before later short reports', () => {
  for (const text of ['PR #43 is open.', `Opened PR #42 and PR #43. ${url} ${url.replace('42', '43')}`]) {
    const turns = [report(`Opened PR #42. ${url}`), report(text), report('Merged into main.')];
    assert.equal(responsePullRequest(turns)?.state, 'open');
  }
  assert.equal(responsePullRequest([report('PR #43 is open.'), report('Merged into main.')], url), null);
});

test('responsePullRequests lists every PR the replies identified, the latest report first, each with its latest state', () => {
  const a = url;
  const b = url.replace('42', '43');
  const turns = [
    report(`Opened [PR #42](${a}).`),
    report(`Opened [PR #43](${b}).`),
    // a reply about the known PR without its link, then one naming both: ambiguous, skipped
    report(`PR #43 is merged.`),
    report(`See ${a} and ${b}.`),
    report(`PR #42 is merged. ${a}`),
  ];
  assert.deepEqual(responsePullRequests(turns), [
    { url: a, number: 42, state: 'merged', source: 'response' },
    { url: b, number: 43, state: 'merged', source: 'response' },
  ]);
  assert.deepEqual(responsePullRequest(turns), { url: a, number: 42, state: 'merged', source: 'response' });
  assert.deepEqual(responsePullRequests('not turns' as never), []);
  assert.equal(responsePullRequest([]), null);
});
