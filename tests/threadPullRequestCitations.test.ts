// Citation-only prose must never supply sidebar PR ownership, including saved history and later implicit reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPullRequestReader, savedReplies } from '../src/lib/threadPullRequest.ts';
import { pullRequestReplies, responsePullRequests } from '../src/lib/responsePullRequest.ts';
import type { AcpRecord } from '../shared/acpItems/records.d.mts';
import { buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';

const cited = 'https://github.com/mopilot-ai/mopilot-internal/pull/2961';
const owned = 'https://github.com/org/repo/pull/42';
const reply = (text: string) => ({ status: 'completed', items: [{ type: 'agentMessage', text, phase: 'final_answer' }] });
const analysis = reply(
  `Du’s complaint is supported by the history. We should batch CI validation while keeping review PRs small.\n\n` +
    `- Mac queue wait was 19 minutes at p95.\n` +
    `- [PR #2961](${cited}) explicitly says repeated retests as main moved led to combining slices into a 643-file PR.`,
);

test('the CI analysis cites a historical PR without claiming it belongs to this session', async () => {
  assert.deepEqual(responsePullRequests([analysis]), []);
  for (const id of ['codex-chat', 'claude:chat', 'acp:agent:chat']) {
    const lookups: unknown[] = [];
    const read = createPullRequestReader({
      attachments: async () => ({ data: [], nextCursor: null }),
      legacy: async () => null,
      head: async () => null,
      responses: async () => [analysis],
      gh: async (url) => {
        lookups.push(url);
        return { ok: true, stdout: '{"state":"MERGED"}' };
      },
    });
    assert.equal(await read(id, '/worktree', true), null, id);
    assert.deepEqual(lookups, [], 'a citation must not be looked up as this chat’s PR');
    assert.equal(read.known(id, '/worktree'), null);
  }
});

test('a citation cannot become the target of a later short merged/open report', () => {
  for (const text of ['Merged into main.', 'The PR is open.', 'The PR is not merged yet.'])
    assert.deepEqual(responsePullRequests([analysis, reply(text)]), [], text);
  // Explicitly reporting this session's work still establishes ownership after an unrelated analysis.
  assert.deepEqual(responsePullRequests([analysis, reply(`Opened [PR #42](${owned}).`), reply('Merged into main.')]), [
    { url: owned, number: 42, state: 'merged', source: 'response' },
  ]);
});

test('a different citation retires implicit context while preserving the previously identified PR', () => {
  const opened = reply(`Opened [PR #42](${owned}).`);
  assert.deepEqual(responsePullRequests([opened, analysis, reply('Merged into main.')]), [
    { url: owned, number: 42, state: 'open', source: 'response' },
  ]);
  // Re-linking the owned PR without a lifecycle assertion does not lose its implicit context.
  assert.equal(responsePullRequests([opened, reply(`See [the PR](${owned}).`), reply('Merged into main.')])[0]?.state, 'merged');
});

test('a short lifecycle report cannot borrow a historical link from another sentence in the same reply', () => {
  for (const text of [
    ...[`[the earlier CI change](${cited})`, `[PR #2961](${cited})`, cited].map((link) => `Merged into main. For background, see ${link}.`),
    `**Merged into main.** For background, see [the earlier CI change](${cited}).`,
    `Merged into main.\n\n[For background, see the earlier CI change](${cited}).`,
    `Merged into main. Does [PR #2961](${cited}) explain the earlier CI failure?`,
    `Merged into main. If [PR #2961](${cited}) explains the earlier CI failure, investigate it.`,
    `Merged into main. [PR #2961](${cited})?`,
  ]) {
    const message = reply(text);
    assert.deepEqual(
      responsePullRequests([reply(`Opened [PR #42](${owned}).`), message]),
      [{ url: owned, number: 42, state: 'merged', source: 'response' }],
      'the short report updates its established owner without borrowing the historical citation',
    );
    assert.deepEqual(responsePullRequests([message]), [], 'without an owner the short report has no PR identity');
  }
  assert.equal(responsePullRequests([reply(`Merged into main.\n\n${owned}`)])[0]?.url, owned, 'a standalone delivery link is retained');
  assert.equal(
    responsePullRequests([reply(`Merged into main. Tests passed. ${owned}`)], owned)[0]?.state,
    'merged',
    'an authoritative identity still accepts its own status alongside extra prose',
  );
});

test('plural lifecycle reports cannot borrow a background, question or conditional reference block', () => {
  const other = cited.replace('2961', '2962');
  for (const text of [
    `All PRs are merged. For background, see ${cited} and ${other}.`,
    `Both PRs are merged. Do ${cited} and ${other} explain the earlier CI failure?`,
    `All PRs are merged. If ${cited} and ${other} explain it, investigate.`,
    `Both PRs are merged. [PR #2961](${cited}) and [PR #2962](${other})?`,
    `All PRs are merged.\n\n- For background, see [PR #2961](${cited}).\n- For background, see [PR #2962](${other}).`,
    `All PRs are merged.\n\n## For background, see [PR #2961](${cited})\n\n## For background, see [PR #2962](${other})`,
  ])
    assert.deepEqual(responsePullRequests([reply(text)]), [], text);
});

test('an explicit delivery link outranks prior implicit context, while an older citation cannot reactivate it', () => {
  const other = owned.replace('/42', '/43');
  const opened = reply(`Opened [PR #42](${owned}).`);
  assert.deepEqual(responsePullRequests([opened, reply(`Merged into main.\n\n[PR #43](${other})`)]), [
    { url: other, number: 43, state: 'merged', source: 'response' },
    { url: owned, number: 42, state: 'open', source: 'response' },
  ]);
  const sameNumber = owned.replace('/org/', '/other/');
  assert.deepEqual(responsePullRequests([opened, reply(`Merged PR #42.\n\n${sameNumber}`)]), [
    { url: sameNumber, number: 42, state: 'merged', source: 'response' },
    { url: owned, number: 42, state: 'open', source: 'response' },
  ]);
  const reports = responsePullRequests([
    opened,
    reply(`Opened [PR #43](${other}).`),
    reply(`For background, see [the earlier PR](${owned}).`),
    reply('Merged into main.'),
  ]);
  assert.equal(reports.length, 2);
  assert.ok(reports.every((p) => p.state === 'open'));
});

test('a linked work report remains valid beside an explanation or test results', () => {
  for (const text of [
    `Opened [PR](${owned}). All 14 focused tests pass.`,
    `Created [pull request](${owned}). Ready for review.`,
    `Opened PR #42. [](${owned})`,
  ])
    assert.deepEqual(responsePullRequests([reply(text)]), [{ url: owned, number: 42, state: 'open', source: 'response' }], text);
});

test('a newly linked identity is rejected when the same reply contradicts its PR number', () => {
  assert.deepEqual(responsePullRequests([reply(`Opened [PR #42](${owned}). PR #43 is open.`)]), []);
  // Rejected prose supplies no implicit target; a subsequent unambiguous work report still succeeds.
  assert.deepEqual(responsePullRequests([reply(`Opened [PR #42](${owned}). PR #43 is open.`), reply('Merged into main.')]), []);
  assert.deepEqual(
    responsePullRequests([
      reply(`Opened [PR #42](${owned}). PR #43 is open.`),
      reply('Merged into main.'),
      reply(`Opened [PR #42](${owned}).`),
    ]),
    [{ url: owned, number: 42, state: 'open', source: 'response' }],
  );
});

test('PR numbers shared by repositories are ambiguous in both short and plural reports', () => {
  const other = owned.replace('/org/', '/other/');
  const third = owned.replace('/42', '/43');
  const opened = [owned, other, third].map((url) => reply(`Opened [PR](${url}).`));
  const retired = reply(`Compare ${owned} and ${other}.`);
  for (const text of ['PR #42 is merged.', 'Both PRs are merged: #42 and #43.']) {
    const reports = responsePullRequests([...opened, retired, reply(text)]);
    assert.equal(reports.length, 3);
    assert.ok(reports.every((p) => p.state === 'open'));
  }
  assert.ok(responsePullRequests([opened[0], opened[2], reply('Both PRs are merged: #42 and #43.')]).every((p) => p.state === 'merged'));
});

test('citations cannot override a monitor, attachment, legacy record or branch identity', async () => {
  for (const source of ['monitor', 'attachment', 'legacy', 'branch']) {
    const read = createPullRequestReader({
      attachments: async () => ({
        data:
          source === 'attachment'
            ? [
                {
                  id: 'attachment',
                  attachmentType: 'pull_request',
                  identityKey: owned,
                  payload: { url: owned },
                  createdAt: 1,
                },
              ]
            : [],
        nextCursor: null,
      }),
      monitored: async () => (source === 'monitor' ? owned : null),
      legacy: async () =>
        source === 'legacy'
          ? JSON.stringify({
              'electron-persisted-atom-state': {
                'pull-request-attachment-records-v3': [{ hostId: 'local', conversationId: 'chat', attachments: [{ url: owned }] }],
              },
            })
          : null,
      head: async () => 'work',
      responses: async () => [analysis],
      gh: async (url) => ({ ok: true, stdout: JSON.stringify({ url: url ?? owned, state: 'OPEN' }) }),
    });
    const pr = await read('chat', '/worktree', true);
    assert.equal(pr?.url, owned, source);
    assert.equal(pr?.state, 'open');
    assert.equal(pr?.entries, undefined, 'the cited PR must not become another owned entry');
  }
});

test('saved replies from an earlier app version are reinterpreted without preserving a false association', async () => {
  const kept = pullRequestReplies([analysis, reply('Merged into main.')]);
  const responses = savedReplies(async () => assert.fail('the unchanged history is already saved'), {
    store: { get: async () => kept, put: async () => assert.fail('no history read to save') },
  });
  const read = createPullRequestReader({
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    head: async () => null,
    responses,
    gh: async () => assert.fail('the saved citation supplies no PR identity'),
  });
  assert.equal(await read('chat', '', true, 'unchanged'), null);
});

test('the real ACP history producer preserves citation boundaries, completed status and legitimate PR reports', () => {
  const translated = (texts: string[]) => {
    const records: AcpRecord[] = texts.flatMap((text, i) => [
      {
        t: 'user',
        turnId: String(i),
        user: { id: `u${i}`, clientId: String(i), content: [{ type: 'text', text: 'request', text_elements: [] }] },
        at: 1,
      },
      { t: 'update', turnId: String(i), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, at: 2 },
      { t: 'end', turnId: String(i), stopReason: 'end_turn', at: 3 },
    ]);
    return buildAcpTurns(records, 'acp:agent:chat', '/worktree');
  };
  const turns = translated([analysis.items[0].text, 'The PR is not merged yet.']);
  assert.equal(turns.length, 2);
  assert.ok(turns.every((turn) => turn.status === 'completed'));
  assert.deepEqual(responsePullRequests(turns), []);
  assert.equal(responsePullRequests(translated([`Opened [PR #42](${owned}).`, 'Merged into main.']))[0]?.state, 'merged');
});
