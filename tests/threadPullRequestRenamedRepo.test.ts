// Historical PR links keep their repository identity when the old name is reused.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { historicalPullRequestUrl } from '../shared/pullRequest.mjs';
import { responsePullRequests } from '../src/lib/responsePullRequest.ts';
import { createPullRequestReader, historyVersion, legacyPullRequests, savedReplies } from '../src/lib/threadPullRequest.ts';

const { cleanReplies } = createRequire(import.meta.url)('../electron/app/ipc/pullRequestReplies.cjs');
const reusedAt = Date.parse('2026-11-21T23:34:53Z');
const oldUrl = (n: number) => `https://github.com/mopilot-ai/mopilot/pull/${n}`;
const movedUrl = (n: number) => `https://github.com/mopilot-ai/mopilot-internal/pull/${n}`;
const opened = (url: string, completedAt?: number) => ({
  status: 'completed',
  completedAt,
  items: [{ type: 'agentMessage', text: `Opened [PR #${url.split('/').at(-1)}](${url}).` }],
});
const unavailable = { ok: false, stdout: '' };
const answer = (url: string, state: string) => ({ ok: true, stdout: JSON.stringify({ url, state }) });

test('a saved open report for PR #5390 uses its current GitHub URL and live merged status after reopening', async () => {
  let kept: unknown;
  const calls: (string | null)[] = [];
  const replies = savedReplies(async () => [opened(oldUrl(5390), (reusedAt - 1_000) / 1_000)], {
    store: {
      get: async () => null,
      put: async (_id, _version, turns) => (kept = cleanReplies(turns)),
    },
  });
  const version = historyVersion(reusedAt + 5_000, 'chat');
  await replies('chat', version);
  const reader = createPullRequestReader({
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    head: async () => null,
    responses: async () => JSON.parse(JSON.stringify(kept)),
    gh: async (url) => {
      calls.push(url);
      return url === movedUrl(5390) ? answer(url, 'MERGED') : unavailable;
    },
  });
  assert.deepEqual(await reader('chat', '', true, version), { url: movedUrl(5390), number: 5390, state: 'merged' });
  assert.deepEqual(await reader.listed('chat', version), [{ url: movedUrl(5390), number: 5390, state: 'merged' }]);
  assert.deepEqual(calls, [movedUrl(5390)]);
});

test('the same saved URL in old and new replies identifies two PRs even if their GitHub reads overlap', async () => {
  const calls: (string | null)[] = [];
  const turns = [opened(oldUrl(1), reusedAt - 1), opened(oldUrl(1), reusedAt)];
  const reader = createPullRequestReader({
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    head: async () => null,
    responses: async () => turns,
    gh: async (url) => {
      calls.push(url);
      return answer(url!, url === oldUrl(1) ? 'OPEN' : 'MERGED');
    },
  });
  const [badge, inbox] = await Promise.all([reader('chat', '', true, 'v1'), reader.listed('chat', 'v1')]);
  const expected = [
    { url: oldUrl(1), number: 1, state: 'open' },
    { url: movedUrl(1), number: 1, state: 'merged' },
  ];
  assert.deepEqual(badge?.entries, expected);
  assert.deepEqual(inbox, expected);
  assert.deepEqual(calls, [oldUrl(1), movedUrl(1)]);
  assert.deepEqual(
    responsePullRequests([
      ...turns,
      { status: 'completed', completedAt: reusedAt + 1, items: [{ type: 'agentMessage', text: 'Merged PR #1.' }] },
    ]).map(({ url, state }) => [url, state]),
    [
      [oldUrl(1), 'open'],
      [movedUrl(1), 'open'],
    ],
    'a number alone cannot say which of the two PRs merged',
  );
});

test('dated native and legacy attachments use their original repository even if the chat is reopened later', async () => {
  const dated = reusedAt - 10_000;
  const desktop = JSON.stringify({
    'electron-persisted-atom-state': {
      'pull-request-attachment-records-v3': [
        { hostId: 'local', conversationId: 'legacy', attachments: [{ url: oldUrl(5390), touchedAt: dated }] },
        { hostId: 'local', conversationId: 'current', attachments: [{ url: oldUrl(1), touchedAt: reusedAt }] },
      ],
    },
  });
  assert.deepEqual({ ...legacyPullRequests(desktop) }, { legacy: [movedUrl(5390)], current: [oldUrl(1)] });

  let replies: ReturnType<typeof opened>[] = [];
  const reader = createPullRequestReader({
    attachments: async () => ({
      data: [
        {
          id: 'attachment',
          attachmentType: 'pull_request',
          identityKey: oldUrl(5390),
          payload: { url: `${oldUrl(5390).replace('mopilot-ai/mopilot', 'MoPilot-AI/MoPilot')}?tab=files#discussion` },
          createdAt: dated,
        },
      ],
      nextCursor: null,
    }),
    legacy: async () => desktop,
    head: async () => null,
    responses: async () => replies,
    gh: async (url) => (url === movedUrl(5390) ? answer(url, 'MERGED') : unavailable),
  });
  const version = historyVersion(reusedAt + 10_000, 'chat');
  assert.deepEqual(await reader('chat', '', true, version), { url: movedUrl(5390), number: 5390, state: 'merged' });
  replies = [opened(movedUrl(5390), reusedAt + 900)];
  assert.deepEqual(await reader.listed('chat', version), [{ url: movedUrl(5390), number: 5390, state: 'merged' }]);
});

for (const source of ['native', 'legacy', 'mixed', 'mixed with a different monitor']) {
  test(`${source} attachments in both repositories make a number-only report ambiguous before the first linked reply`, async () => {
    const other = 'https://github.com/example/other/pull/2';
    const mixed = source.startsWith('mixed');
    const data = [reusedAt - 1, reusedAt].map((createdAt) => ({
      id: String(createdAt),
      attachmentType: 'pull_request',
      identityKey: oldUrl(1),
      payload: { url: oldUrl(1) },
      createdAt,
    }));
    const reader = createPullRequestReader({
      attachments: async () => ({ data: source === 'legacy' ? [] : mixed ? data.slice(1) : data, nextCursor: null }),
      legacy: async () =>
        source !== 'native'
          ? JSON.stringify({
              'electron-persisted-atom-state': {
                'pull-request-attachment-records-v3': [
                  {
                    hostId: 'local',
                    conversationId: 'chat',
                    attachments: (mixed ? data.slice(0, 1) : data).map((entry) => ({
                      url: entry.payload.url,
                      touchedAt: entry.createdAt,
                    })),
                  },
                ],
              },
            })
          : null,
      head: async () => null,
      monitored: async () => (source === 'mixed with a different monitor' ? other : null),
      responses: async () => [{ status: 'completed', items: [{ type: 'agentMessage', text: 'Merged PR #1.' }] }],
      gh: async () => unavailable,
    });
    assert.deepEqual(
      (await reader.listed('chat', 'v1')).map(({ url, state }) => [url, state]),
      [...(source === 'mixed with a different monitor' ? [[other, 'unknown']] : []), [oldUrl(1), 'unknown'], [movedUrl(1), 'unknown']],
    );
  });
}

test('an old monitor URL stops masking the chat’s moved PR when GitHub confirms the old URL is missing', async () => {
  const missing = {
    ...unavailable,
    stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 5390. (repository.pullRequest)',
  };
  for (const [original, reported, moved, expected] of [
    [missing, true, answer(movedUrl(5390), 'MERGED'), [movedUrl(5390), 'merged']],
    [missing, true, unavailable, [oldUrl(5390), 'unknown']],
    [missing, true, answer(movedUrl(5391), 'MERGED'), [oldUrl(5390), 'unknown']],
    [answer(movedUrl(5390), 'MERGED'), true, answer(movedUrl(5390), 'MERGED'), [oldUrl(5390), 'unknown']],
    [missing, false, answer(movedUrl(5390), 'MERGED'), [oldUrl(5390), 'unknown']],
    [
      { ...missing, stderr: `${missing.stderr}\nGraphQL: GitHub authentication failed` },
      true,
      answer(movedUrl(5390), 'MERGED'),
      [oldUrl(5390), 'unknown'],
    ],
    [{ ...unavailable, stderr: 'GitHub authentication failed' }, true, answer(movedUrl(5390), 'MERGED'), [oldUrl(5390), 'unknown']],
    [answer(oldUrl(5390), 'OPEN'), true, answer(movedUrl(5390), 'MERGED'), [oldUrl(5390), 'open']],
  ] as const) {
    const reader = createPullRequestReader({
      attachments: async () => ({ data: [], nextCursor: null }),
      legacy: async () => null,
      head: async () => null,
      monitored: async () => oldUrl(5390),
      responses: async () => (reported ? [opened(oldUrl(5390), reusedAt - 1)] : []),
      gh: async (url) => (url === movedUrl(5390) ? moved : original),
    });
    const pr = await reader('chat');
    assert.deepEqual([pr?.url, pr?.state], expected);
    if (pr?.url === movedUrl(5390)) assert.equal(pr.entries, undefined, 'the retired binding does not add a second badge entry');
    if (moved.stdout.includes('/5391')) assert.equal(pr?.entries?.[1]?.source, 'response', 'a different PR cannot answer the moved lookup');
  }
});

test('a historical number-only reply cannot claim the reused name from an undated binding', () => {
  const reports = responsePullRequests(
    [
      { status: 'completed', completedAt: reusedAt - 2, items: [{ type: 'agentMessage', text: 'Merged PR #1.' }] },
      opened(oldUrl(1), reusedAt - 1),
    ],
    oldUrl(1),
  );
  assert.deepEqual(
    reports.map(({ url, state }) => [url, state]),
    [[movedUrl(1), 'open']],
  );
});

test('recovering an obsolete binding keeps a current reference with the same PR number independent', async () => {
  for (const source of ['attachment', 'reply']) {
    const reader = createPullRequestReader({
      attachments: async () => ({
        data:
          source === 'attachment'
            ? [
                {
                  id: 'current',
                  attachmentType: 'pull_request',
                  identityKey: oldUrl(1),
                  payload: { url: oldUrl(1) },
                  createdAt: reusedAt,
                },
              ]
            : [],
        nextCursor: null,
      }),
      legacy: async () => null,
      head: async () => null,
      monitored: async () => oldUrl(1),
      responses: async () => [opened(oldUrl(1), reusedAt - 1), ...(source === 'reply' ? [opened(oldUrl(1), reusedAt)] : [])],
      gh: async (url) =>
        url === movedUrl(1)
          ? answer(url, 'MERGED')
          : {
              ...unavailable,
              stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 1. (repository.pullRequest)',
            },
    });
    assert.deepEqual(
      (await reader.listed('chat', 'v1')).map(({ url }) => url),
      [oldUrl(1), movedUrl(1)],
      source,
    );
  }
});

test('a dated Codex desktop attachment can recover a missing monitor URL without a reply', async () => {
  const reader = createPullRequestReader({
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () =>
      JSON.stringify({
        'electron-persisted-atom-state': {
          'pull-request-attachment-records-v3': [
            { hostId: 'local', conversationId: 'chat', attachments: [{ url: oldUrl(5390), touchedAt: reusedAt - 1 }] },
          ],
        },
      }),
    head: async () => null,
    monitored: async () => oldUrl(5390),
    gh: async (url) =>
      url === movedUrl(5390)
        ? answer(url, 'MERGED')
        : {
            ...unavailable,
            stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 5390. (repository.pullRequest)',
          },
  });
  assert.deepEqual(await reader('chat'), { url: movedUrl(5390), number: 5390, state: 'merged' });
});

test('a number-only report after reuse does not keep an obsolete monitor URL as a separate PR', async () => {
  let available = false;
  const reader = createPullRequestReader({
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    head: async () => null,
    monitored: async () => oldUrl(1),
    responses: async () => [
      { status: 'completed', completedAt: reusedAt + 1, items: [{ type: 'agentMessage', text: 'Merged PR #1.' }] },
      opened(movedUrl(1), reusedAt + 2),
    ],
    gh: async (url) =>
      url === movedUrl(1)
        ? available
          ? answer(url, 'MERGED')
          : { ...unavailable, stderr: 'GitHub authentication failed' }
        : {
            ...unavailable,
            stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 1. (repository.pullRequest)',
          },
  });
  assert.deepEqual(await reader.listed('chat', 'v1'), [
    { url: oldUrl(1), number: 1, state: 'unknown' },
    { url: movedUrl(1), number: 1, state: 'open', source: 'response' },
  ]);
  available = true;
  assert.deepEqual(await reader('chat', '', true, 'v1'), { url: movedUrl(1), number: 1, state: 'merged' });
});

test('a failed lookup leaves a report on the resolved PR and a fresh lookup can recover', async () => {
  let available = false;
  const reader = createPullRequestReader({
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    head: async () => null,
    responses: async () => [opened(oldUrl(5390), reusedAt - 1)],
    gh: async (url) => {
      assert.equal(url, movedUrl(5390));
      if (!available) throw new Error('GitHub offline');
      return answer(url!, 'MERGED');
    },
  });
  assert.deepEqual(await reader('chat'), { url: movedUrl(5390), number: 5390, state: 'open', source: 'response' });
  available = true;
  assert.deepEqual(await reader('chat', '', true), { url: movedUrl(5390), number: 5390, state: 'merged' });
});

test('historical delivery links and later qualified reports use one PR identity', () => {
  const at = reusedAt - 10_000;
  const turns = [
    {
      status: 'completed',
      completedAt: at,
      items: [
        {
          type: 'agentMessage',
          text: `I opened both PRs.\n\n| PR | Detail |\n| --- | --- |\n| [PR #9](${oldUrl(9)}) | Work |\n| [PR #10](${oldUrl(10)}) | Tests |`,
        },
      ],
    },
    {
      status: 'completed',
      completedAt: at + 500,
      items: [
        {
          type: 'agentMessage',
          text: `Merged [mopilot-ai/mopilot#9](${oldUrl(9)}) and verified commit \`abc123\` is on remote \`main\` (see [mopilot-ai/mopilot-internal#9](${movedUrl(9)})).`,
        },
      ],
    },
    opened(movedUrl(10), reusedAt + 1000),
  ];
  assert.deepEqual(
    responsePullRequests(turns).map(({ url, state }) => [url, state]),
    [
      [movedUrl(10), 'open'],
      [movedUrl(9), 'merged'],
    ],
  );
});

test('the rename requires a valid timestamp from the original repository’s lifetime and an exact repository match', () => {
  for (const at of [undefined, null, Number.POSITIVE_INFINITY, Number.NaN, 0, -5, Date.parse('2026-10-01'), reusedAt, reusedAt + 1])
    assert.equal(historicalPullRequestUrl(oldUrl(1), at), oldUrl(1));
  for (const at of [reusedAt - 1, reusedAt / 1_000 - 1]) assert.equal(historicalPullRequestUrl(oldUrl(1), at), movedUrl(1));
  for (const url of [movedUrl(1), 'https://github.com/another/mopilot/pull/1', 'https://github.com/mopilot-ai/mopilot-oss/pull/1'])
    assert.equal(historicalPullRequestUrl(url, reusedAt - 1), url);
});
