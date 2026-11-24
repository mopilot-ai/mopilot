// Recovery of sidebar and inbox PR status from a completed reply that verifies a merge commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPullRequestReader, MAX_ENTRIES, savedReplies } from '../src/lib/threadPullRequest.ts';
import { pullRequestReplies } from '../src/lib/responsePullRequest.ts';

const oss = 'https://github.com/mopilot-ai/mopilot/pull/6';
const internal = 'https://github.com/mopilot-ai/mopilot-internal/pull/5644';
const oid = '3e041eaa3b96b18c961d66c2ba0c02d3b59101ac';
const verification = 'I verified that merge commit `3e041ea` and the snapshot are on remote `main`.';
const delivery = `[OSS PR #6](${oss})`;
const report = `Synced 445 files from internal main. ${verification} ${delivery}\n\nCI covered all 5 changed lines in the fix. [Internal PR #5644](${internal})`;
const turn = (text: string, phase = 'final_answer') => ({
  status: 'completed',
  completedAt: Date.UTC(2026, 10, 24),
  items: [{ type: 'agentMessage', phase, text }],
});

function reader(
  text: string | string[],
  github: unknown = { url: oss, state: 'MERGED', mergeCommit: { oid } },
  phase?: string,
  binding?: string,
) {
  const lookups: (string | null)[] = [];
  const responses = savedReplies(async () => assert.fail('the existing saved replies are sufficient'), {
    store: {
      get: async () => pullRequestReplies([text].flat().map((item) => turn(item, phase))),
      put: async () => assert.fail('no history changed'),
    },
  });
  const read = createPullRequestReader({
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    monitored: async () => binding ?? null,
    head: async () => null,
    responses,
    gh: async (url) => {
      lookups.push(url);
      return { ok: true, stdout: JSON.stringify(typeof github === 'function' ? github(url) : github) };
    },
  });
  return { read, lookups };
}

test('the original sync reply recovers a merged badge and inbox entry without claiming the linked internal fix', async () => {
  const { read, lookups } = reader(report);
  for (const id of ['codex-chat', 'claude:chat', 'acp:agent:chat']) {
    const badge = await read(id, '/old-worktree', true, 'version');
    assert.equal(badge?.url, oss);
    assert.equal(badge?.state, 'merged');
    assert.deepEqual(await read.listed(id, 'version'), [badge]);
  }
  assert.deepEqual(lookups, [oss]);
});

test('a commit verification does not borrow citations, plans, or withdrawn assertions', async () => {
  for (const text of [
    verification,
    verification + ' [PR #61](' + oss + ')',
    verification + ' [Earlier PR #6](' + oss + ')',
    verification + ' See ' + delivery,
    verification + ' ' + delivery + '?',
    verification + '\n\n' + delivery,
    verification.replace('3e041ea', 'not-a-hash') + ' ' + delivery,
    verification.replace('main`.', 'main`?') + ' ' + delivery,
    'Example reply:\n\n' + verification + ' ' + delivery,
    'If CI passes:\n\n' + verification + ' ' + delivery,
    verification + ' ' + delivery + '\n\nCorrection: No merge was performed.',
  ]) {
    const { read, lookups } = reader(text);
    assert.equal(await read('chat', '', true, 'version'), null, text);
    assert.deepEqual(lookups, [], text);
  }
  const { read, lookups } = reader(report, undefined, 'commentary');
  assert.equal(await read('chat', '', true, 'version'), null);
  assert.deepEqual(lookups, []);
});

test('GitHub must confirm the PR is merged at the reported commit', async () => {
  for (const pr of [
    { url: oss, state: 'MERGED' },
    { url: oss, state: 'MERGED', mergeCommit: { oid: false } },
    { url: oss, state: 'MERGED', mergeCommit: { oid: '3e041ea' } },
    { url: oss, state: 'MERGED', mergeCommit: { oid: 'a'.repeat(40) } },
    { url: internal, state: 'MERGED', mergeCommit: { oid } },
    { url: oss, state: 'OPEN', mergeCommit: { oid } },
    null,
  ]) {
    const { read, lookups } = reader(report, pr);
    assert.equal(await read('chat', '', true, 'version'), null);
    assert.deepEqual(lookups, [oss]);
  }
});

test('separate verified reports survive together in the badge and inbox, including beside a monitor binding', async () => {
  const text = verification + ' ' + delivery + '\n\n' + verification + ' [PR #5644](' + internal + ')';
  const github = (url: string) => ({ url, state: 'MERGED', mergeCommit: { oid } });
  for (const binding of [undefined, oss]) {
    const { read, lookups } = reader(text, github, undefined, binding);
    const order = binding ? [oss, internal] : [internal, oss];
    assert.deepEqual(
      (await read('chat', '', true, 'version'))?.entries?.map((pr) => pr.url),
      order,
    );
    assert.deepEqual(
      (await read.listed('chat', 'version')).map((pr) => pr.url),
      order,
    );
    assert.deepEqual(lookups, [internal, oss]);
  }
});

test('repeated reports spend one lookup per PR and any matching commit can verify it', async () => {
  const older = verification + ' ' + delivery;
  const newer = verification + ' [PR #5644](' + internal + ')';
  const text = [older, older.replace('3e041ea', 'fffffff'), ...Array<string>(12).fill(newer)].join('\n\n');
  const { read, lookups } = reader(text, (url: string) => ({ url, state: url === oss ? 'MERGED' : 'OPEN', mergeCommit: { oid } }));
  assert.equal((await read('chat', '', true, 'version'))?.url, oss);
  assert.deepEqual(lookups, [internal, oss]);
});

test('a merged response without usable commit evidence is retryable', async () => {
  let mergeCommit: { oid: string } | null = null;
  const { read, lookups } = reader(report, () => ({ url: oss, state: 'MERGED', mergeCommit }));
  assert.equal(await read('chat', '', true, 'version'), null);
  mergeCommit = { oid };
  assert.equal((await read('chat', '', true, 'version'))?.state, 'merged');
  assert.deepEqual(lookups, [oss, oss]);
});

test('a numbered withdrawal only affects that PR', async () => {
  for (const number of [6, 5644]) {
    const { read, lookups } = reader(report + '\n\nCorrection: We did not merge PR #' + number + '.');
    assert.equal((await read('chat', '', true, 'version'))?.url, number === 6 ? undefined : oss);
    assert.deepEqual(lookups, number === 6 ? [] : [oss]);
  }
});

test('withdrawals apply to earlier reports and a linked correction uses its full PR URL', async () => {
  const sameNumber = internal.replace('/5644', '/6');
  const source = verification + ' ' + delivery;
  const other = verification + ' [PR #6](' + sameNumber + ')';
  for (const label of ['PR #6', 'the PR']) {
    const correction = 'Correction: We did not merge [' + label + '](' + sameNumber + ').';
    for (const text of [[source, other, correction], [source + '\n\n' + other + '\n\n' + correction]]) {
      const { read, lookups } = reader(text);
      assert.equal((await read('chat', '', true, 'version'))?.url, oss);
      assert.deepEqual(lookups, [oss]);
    }
  }
  const earlier = reader('We did not merge PR #6. CI was red. ' + source);
  assert.equal((await earlier.read('chat', '', true, 'version'))?.url, oss);
  const coded = reader([source, 'Correction: We did not actually merge PR \x60#6\x60.']);
  assert.equal(await coded.read('chat', '', true, 'version'), null);
});

test('an explicitly linked report stays primary beside verified links in the same reply', async () => {
  const explicit = 'https://github.com/other/repo/pull/2';
  const reports = verification + ' ' + delivery;
  const link = '[PR #2](' + explicit + ')';
  const github = (url: string) => ({ url, state: url === explicit ? 'OPEN' : 'MERGED', mergeCommit: { oid } });
  for (const opened of ['Opened ' + link + '.', 'Opened PR #2. ' + link]) {
    const { read } = reader(opened + '\n\n' + reports, github);
    assert.deepEqual(
      (await read('chat', '', true, 'version'))?.entries?.map((pr) => [pr.url, pr.state]),
      [
        [explicit, 'open'],
        [oss, 'merged'],
      ],
    );
  }
  const mixed = 'Opened ' + link + '.\n\n' + reports;
  const withCitation = reader(mixed + '\n\nFor background, see [PR #5644](' + internal + ').', github);
  assert.equal((await withCitation.read('chat', '', true, 'version'))?.url, oss);
  assert.deepEqual(withCitation.lookups, [oss]);
  const contradicted = reader('Opened ' + link + '. Correction: I meant PR #3.\n\n' + reports, github);
  assert.equal((await contradicted.read('chat', '', true, 'version'))?.url, oss);
  assert.deepEqual(contradicted.lookups, [oss]);
});

test('higher-priority entries reserve the lookup budget', async () => {
  const attached = Array.from({ length: MAX_ENTRIES }, (_, i) => ({
    id: String(i + 1),
    attachmentType: 'pull_request',
    identityKey: String(i + 1),
    createdAt: i + 1,
    payload: { url: 'https://github.com/other/repo/pull/' + (i + 1) },
  }));
  const lookups: (string | null)[] = [];
  const read = createPullRequestReader({
    attachments: async () => ({ data: attached, nextCursor: null }),
    legacy: async () => null,
    head: async () => null,
    responses: async () => [turn(report)],
    gh: async (url) => {
      lookups.push(url);
      return { ok: true, stdout: JSON.stringify({ url, state: 'OPEN' }) };
    },
  });
  assert.equal((await read('chat'))?.entries?.length, MAX_ENTRIES);
  assert.equal(lookups.length, MAX_ENTRIES);
  assert.ok(!lookups.includes(oss));
});
