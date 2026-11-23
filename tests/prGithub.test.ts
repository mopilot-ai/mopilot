// GitHub PR response contracts, event identity and trusted feedback pagination.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPullRequest } from '../electron/platform/prGithub.cjs';

const url = 'https://github.com/org/repo/pull/42';
const base = () => ({
  url,
  title: 'A PR',
  state: 'OPEN',
  headRefOid: 'opaque head',
  headRefName: 'feature/child',
  baseRefName: 'feature/parent',
  mergeable: 'MERGEABLE',
  statusCheckRollup: [] as any[],
});
const check = (extra = {}) => ({
  __typename: 'CheckRun',
  name: 'unit-tests',
  status: 'COMPLETED',
  conclusion: 'FAILURE',
  detailsUrl: 'https://github.com/check/1',
  completedAt: 'now',
  ...extra,
});
const comment = (extra = {}) => ({
  node_id: 'comment:1',
  body: 'Fix this',
  updated_at: 'today',
  user: { login: 'reviewer', type: 'User' },
  author_association: 'COLLABORATOR',
  ...extra,
});
function fixture(responses: any[]) {
  const calls: any[] = [];
  const run = async (cmd: string, args: string[], opts: any) => {
    calls.push([cmd, args, opts]);
    assert.equal(cmd, 'gh');
    assert.equal(opts.cwd, '/work with spaces');
    assert.equal(opts.timeout, 30_000);
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r?.raw ?? { ok: true, stdout: JSON.stringify(r), stderr: '' };
  };
  return { read: (comments = false, link = url) => readPullRequest(run, '/work with spaces', link, comments), calls };
}

test('checks and conflicts produce stable events; new heads and reruns get distinct identities', async () => {
  const source = {
    ...base(),
    mergeable: 'CONFLICTING',
    statusCheckRollup: [
      check(),
      check({ name: 'lint', conclusion: 'SUCCESS' }),
      check({ name: 'in progress', status: 'IN_PROGRESS', conclusion: '' }),
      { __typename: 'StatusContext', context: 'merge-on-green', state: 'ERROR', targetUrl: 'https://checks' },
      { __typename: 'StatusContext', context: 'waiting', state: 'EXPECTED' },
      { __typename: 'StatusContext', context: 'pending', state: 'PENDING' },
      { __typename: 'StatusContext', context: 'success', state: 'SUCCESS' },
    ],
  };
  const a = await fixture([source]).read();
  assert.equal(a.failed, 2);
  assert.equal(a.headRefName, 'feature/child');
  assert.equal(a.baseRefName, 'feature/parent');
  assert.equal(a.pending, 3);
  assert.equal(a.events.length, 3);
  assert.deepEqual(a, await fixture([source]).read());
  const stacked = await fixture([{ ...source, baseRefName: 'another-parent' }]).read();
  assert.notEqual(a.events.at(-1)!.key, stacked.events.at(-1)!.key);
  assert.equal(a.events[0].key, stacked.events[0].key);
  assert.notEqual(a.events[0].key, (await fixture([{ ...source, headRefOid: 'new' }]).read()).events[0].key);
  Object.assign(source.statusCheckRollup[0], { completedAt: 'later' });
  assert.notEqual(a.events[0].key, (await fixture([source]).read()).events[0].key);
});

test('trusted non-self discussion, inline and review bodies are paginated; untrusted and empty comments never wake a chat', async () => {
  const f = fixture([
    base(),
    { login: 'me' },
    [
      [comment(), comment({ node_id: 'self', user: { login: 'me' } }), comment({ node_id: 'outsider', author_association: 'NONE' })],
      [comment({ node_id: 'bot', author_association: 'NONE', user: { login: 'app[bot]', type: 'Bot' } })],
    ],
    [[comment({ node_id: 'inline' }), comment({ node_id: 'empty', body: '   ' })]],
    [[comment({ node_id: 'review', updated_at: undefined, submitted_at: 'yesterday', author_association: 'OWNER' })]],
  ]);
  const result = await f.read(true);
  assert.equal(result.events.length, 4);
  assert.ok(result.events.every((e: any) => !e.text.includes('Fix this')));
  assert.deepEqual(
    f.calls.slice(2).map((c) => c[1]),
    [
      ['api', 'repos/org/repo/issues/42/comments', '--paginate', '--slurp'],
      ['api', 'repos/org/repo/pulls/42/comments', '--paginate', '--slurp'],
      ['api', 'repos/org/repo/pulls/42/reviews', '--paginate', '--slurp'],
    ],
  );
  const unchanged = await fixture([base(), { login: 'me' }, [[comment()]], [[]], [[]]]).read(true);
  const edited = await fixture([base(), { login: 'me' }, [[comment({ updated_at: 'tomorrow' })]], [[]], [[]]]).read(true);
  assert.notEqual(unchanged.events[0].key, edited.events[0].key);
  for (const state of ['MERGED', 'CLOSED']) assert.equal((await fixture([{ ...base(), state }]).read(true)).events.length, 0);
});

test('malformed records, missing required fields and unexpected shapes propagate actionable errors', async () => {
  const bad = [
    null,
    [],
    {},
    { ...base(), url: url + '0' },
    { ...base(), state: 'invalid' },
    { ...base(), headRefOid: 1 },
    { ...base(), title: '' },
    { ...base(), headRefName: null },
    { ...base(), baseRefName: 1 },
    { ...base(), mergeable: null },
    { ...base(), statusCheckRollup: null },
  ];
  for (const source of bad) await assert.rejects(fixture([source]).read(), /incomplete PR data/);
  for (const source of [null, [], {}, check({ name: null }), check({ conclusion: null }), check({ status: null }), { __typename: 'Other' }])
    await assert.rejects(fixture([{ ...base(), statusCheckRollup: [source] }]).read(), /incomplete PR data/);
  for (const viewer of [null, [], {}, { login: 1 }]) await assert.rejects(fixture([base(), viewer]).read(true), /incomplete/);
  for (const pages of [
    null,
    {},
    [null],
    [[null]],
    [[[]]],
    [[{}]],
    [[comment({ node_id: null })]],
    [[comment({ body: null })]],
    [[comment({ updated_at: null })]],
    [[comment({ user: [] })]],
    [[comment({ user: {} })]],
    [[comment({ author_association: null })]],
  ])
    await assert.rejects(fixture([base(), { login: 'me' }, pages]).read(true), /incomplete/);
});

test('transport, auth failures, timeout and truncated JSON remain failures; invalid URLs never execute a process', async () => {
  for (const error of [
    new Error('timeout'),
    { raw: { ok: false, stderr: 'not signed in' } },
    { raw: { ok: false, stderr: '' } },
    { raw: { ok: true, stdout: '{' } },
  ])
    await assert.rejects(fixture([error]).read());
  const f = fixture([]);
  await assert.rejects(f.read(false, '--shell-argument'), /GitHub pull request URL/);
  assert.equal(f.calls.length, 0);
});

test('valid mixed-case PR URLs and unsubmitted self reviews are accepted; unknown check enums are rejected', async () => {
  const result = await fixture([
    { ...base(), url: 'https://github.com/ORG/Repo/pull/42' },
    { login: 'me' },
    [[]],
    [[]],
    [[comment({ user: { login: 'me' }, updated_at: undefined, submitted_at: null, state: 'PENDING' })]],
  ]).read(true);
  assert.equal(result.url, url);
  assert.equal(result.events.length, 0);
  for (const status of [
    check({ conclusion: 'FUTURE' }),
    check({ status: 'FUTURE' }),
    check({ conclusion: '' }),
    { __typename: 'StatusContext', context: 'ci', state: 'FUTURE' },
  ])
    await assert.rejects(fixture([{ ...base(), statusCheckRollup: [status] }]).read(), /incomplete/);
});

test("a top-level inline comment from the viewer's own account (a posted code review finding) wakes the chat; their replies, discussion and reviews never do", async () => {
  const me = { login: 'me', type: 'User' };
  const result = await fixture([
    base(),
    { login: 'me' },
    // the agent's own summary in the discussion
    [[comment({ node_id: 'own-discussion', user: me, author_association: 'OWNER' })]],
    [
      [
        // a finding /code-review --comment posted as the user, even on a repository where the user is no collaborator
        comment({ node_id: 'own-finding', user: me, author_association: 'CONTRIBUTOR' }),
        // the agent's answer in the finding's thread
        comment({ node_id: 'own-reply', user: me, author_association: 'OWNER', in_reply_to_id: 7 }),
        comment({ node_id: 'own-empty', user: me, body: ' ' }),
      ],
    ],
    [[comment({ node_id: 'own-review', user: me, updated_at: undefined, submitted_at: 'today' })]],
  ]).read(true);
  assert.deepEqual(
    result.events.map((e: any) => e.text),
    ['New or edited inline review comment from your own account (a posted code review finding); comment id own-finding.'],
  );
  // a malformed one of the viewer's own is still refused
  await assert.rejects(fixture([base(), { login: 'me' }, [[]], [[comment({ user: me, node_id: '' })]], [[]]]).read(true), /incomplete/);
});

test('positive check completion is explicit: no checks, neutral, skipped, stale, pending and failed never mean passed', async () => {
  for (const conclusion of ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE', 'FAILURE']) {
    const result = await fixture([{ ...base(), statusCheckRollup: [check({ conclusion })] }]).read();
    assert.equal(result.checksPassed, conclusion === 'SUCCESS');
  }
  assert.equal((await fixture([base()]).read()).checksPassed, false);
  assert.equal(
    (await fixture([{ ...base(), statusCheckRollup: [check({ conclusion: '', status: 'IN_PROGRESS' })] }]).read()).checksPassed,
    false,
  );
  const success = { __typename: 'StatusContext', context: 'unit-tests', state: 'SUCCESS' };
  assert.equal((await fixture([{ ...base(), statusCheckRollup: [success] }]).read()).checksPassed, true);
});

test('the merge state and whether something merges it without the user (auto-merge, a landing label) are read', async () => {
  const read = (extra: any) => fixture([{ ...base(), ...extra }]).read();
  const plain = await read({});
  assert.deepEqual([plain.mergeable, plain.mergeState, plain.landing], ['MERGEABLE', 'UNKNOWN', false]);
  assert.equal((await read({ mergeStateStatus: 'CLEAN' })).mergeState, 'CLEAN');
  assert.equal((await read({ autoMergeRequest: { enabledAt: 'now' } })).landing, true);
  assert.equal((await read({ autoMergeRequest: null, labels: [null, { name: 'bug' }, { name: 'merge-on-green' }] })).landing, true);
  assert.equal((await read({ labels: [{ name: 'bug' }] })).landing, false);
});
