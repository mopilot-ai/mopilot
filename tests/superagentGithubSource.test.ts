// Superagent GitHub source poller on a fake GitHub: 200/304/403/429, intervals, pagination, deleted subjects, bots, replay and failure isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './support/waitFor.ts';
import { userError } from '../shared/userError.mjs';
import src from '../electron/superagent/sources/github.cjs';
import { API, NOTES, SINCE0, commentsUrl, note, issueBody, commentBody, rig } from './support/superagentGithubRig.ts';

test('200 emits the thread and its comment, reads only, stores the cursor and schedules by X-Poll-Interval', async () => {
  const r = rig();
  r.routes.set(NOTES, {
    headers: { etag: 'e1', 'last-modified': 'lm1', 'x-poll-interval': '90' },
    body: [note(1)],
  });
  r.routes.set(`${API}/repos/o/r/issues/1`, { body: issueBody(1) });
  r.routes.set(commentsUrl(1), { body: [commentBody('IC_1')] });
  r.source.start();
  assert.equal(r.timers[0].ms, 0);
  await r.fire();
  const subject = { type: 'issue', nodeId: 'I_1', number: 1, url: 'https://github.com/o/r/issues/1' };
  const repo = { nodeId: 'R_1', fullName: 'o/r' };
  // the issue opened inside the window, and the comment on it
  assert.deepEqual(r.events, [
    {
      source: 'github',
      externalId: 'I_1',
      threadKey: 'I_1',
      kind: 'issue.opened',
      actor: { login: 'alice', id: 5, type: 'User' },
      repo,
      subject,
      body: 'issue 1',
      occurredAt: '2026-01-02T00:00:00Z',
    },
    {
      source: 'github',
      externalId: 'IC_1',
      threadKey: 'I_1',
      kind: 'issue.comment',
      actor: { login: 'alice', id: 5, type: 'User' },
      repo,
      subject,
      body: 'c IC_1',
      occurredAt: '2026-01-03T00:00:00Z',
    },
  ]);
  assert.deepEqual(r.stored.get('github-notifications:o/r'), {
    since: SINCE0,
    etag: 'e1',
    lastModified: 'lm1',
    etagFor: SINCE0,
    pollMs: 90_000,
  });
  assert.equal(r.timers[0].ms, 90_000);
  assert.ok(r.calls.every((c) => c.method === 'GET' && c.headers.authorization === 'Bearer tok'));
  assert.deepEqual(r.statuses.at(-1), { state: 'ok', delayMs: 90_000 });
});

test('a notification without a comment emits the issue itself; no etag headers store as undefined', async () => {
  const r = rig();
  r.routes.set(NOTES, { body: [note(2)] });
  r.routes.set(`${API}/repos/o/r/issues/2`, { body: issueBody(2) });
  r.source.start();
  await r.fire();
  assert.equal(r.events[0].kind, 'issue.opened');
  assert.equal(r.events[0].externalId, 'I_2');
  assert.equal(r.stored.get('github-notifications:o/r').etag, undefined);
  assert.equal(r.timers[0].ms, 60_000);
});

test('304 emits nothing, sends the stored validators, and picks up a changed interval', async () => {
  const r = rig({ cursor: { since: SINCE0, etag: 'e1', lastModified: 'lm1', etagFor: SINCE0, pollMs: 60_000 } });
  r.routes.set(NOTES, { status: 304, headers: { 'x-poll-interval': '120' } });
  r.source.start();
  await r.fire();
  assert.deepEqual(r.events, []);
  assert.equal(r.calls[0].headers['if-none-match'], 'e1');
  assert.equal(r.calls[0].headers['if-modified-since'], 'lm1');
  assert.equal(r.timers[0].ms, 120_000);
  assert.equal(r.stored.get('github-notifications:o/r').pollMs, 120_000);
  assert.deepEqual(r.statuses.at(-1), { state: 'unchanged', delayMs: 120_000 });
  // an unchanged interval is not rewritten, and a missing header keeps the stored one
  r.routes.set(NOTES, { status: 304 });
  r.stored.set('github-notifications:o/r', { pollMs: 120_000 });
  await r.fire();
  assert.equal(r.timers[0].ms, 120_000);
});

test('a first run with no cursor sends no validators', async () => {
  const r = rig();
  r.routes.set(NOTES, { status: 304 });
  r.source.start();
  await r.fire();
  assert.equal(r.calls[0].headers['if-none-match'], undefined);
  assert.equal(r.timers[0].ms, 60_000);
});

test('429 with Retry-After and 403 primary reset back off, keep the cursor, and recover', async () => {
  const r = rig({ cursor: { etag: 'old', pollMs: 60_000 } });
  r.routes.set(NOTES, { status: 429, headers: { 'retry-after': '120' } });
  r.source.start();
  await r.fire();
  assert.equal(r.timers[0].ms, 120_000);
  assert.deepEqual(r.statuses.at(-1), { state: 'limited', delayMs: 120_000, reason: userError(new Error('GitHub 429')) });
  r.routes.set(NOTES, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' } });
  await r.fire();
  assert.equal(r.timers[0].ms, 90_000);
  assert.equal(r.stored.get('github-notifications:o/r').etag, 'old');
  r.routes.set(NOTES, { body: [] });
  await r.fire();
  assert.equal(r.timers[0].ms, 60_000);
});

test('a secondary limit without headers waits a growing minute', async () => {
  const r = rig();
  r.routes.set(NOTES, { status: 403, body: { message: 'secondary rate limit' } });
  r.source.start();
  await r.fire();
  assert.equal(r.timers[0].ms, 60_000);
  await r.fire();
  assert.equal(r.timers[0].ms, 120_000);
});

test('a limit on an item request aborts the poll before the cursor moves', async () => {
  const r = rig();
  r.routes.set(NOTES, { headers: { etag: 'new' }, body: [note(1)] });
  r.routes.set(`${API}/repos/o/r/issues/1`, { status: 429, headers: { 'retry-after': '5' } });
  r.source.start();
  await r.fire();
  assert.equal(r.stored.has('github-notifications:o/r'), false);
  assert.equal(r.timers[0].ms, 5000);
});

test('401, a missing token, 5xx and a network error each back off and report', async () => {
  const r = rig();
  r.routes.set(NOTES, { status: 401 });
  r.source.start();
  await r.fire();
  assert.equal(r.timers[0].ms, 300_000);
  assert.equal(r.statuses.at(-1).state, 'error');
  r.routes.set(NOTES, { status: 500 });
  await r.fire();
  assert.equal(r.timers[0].ms, 60_000);
  r.routes.set(NOTES, () => {
    throw new Error('boom');
  });
  await r.fire();
  assert.equal(r.timers[0].ms, 120_000);
  assert.equal(r.statuses.at(-1).reason, userError(new Error('boom')));
  const none = rig({ token: null });
  none.source.start();
  await none.fire();
  assert.equal(none.timers[0].ms, 300_000);
  assert.equal(none.calls.length, 0);
});

test('a non-Error throw from a status listener or fetch is survived', async () => {
  const r = rig();
  r.routes.set(NOTES, () => {
    throw 'plain';
  });
  r.source.start();
  await r.fire();
  assert.equal(r.statuses.at(-1).reason, userError('plain'));
});

test('notifications paginate by Link, and non-api links are not followed', async () => {
  const r = rig();
  const page2 = `${API}/repos/o/r/notifications?page=2`;
  r.routes.set(NOTES, { headers: { link: `<${page2}>; rel="next"` }, body: [note(1)] });
  r.routes.set(page2, { body: [note(2), note(3, {}, { type: 'Release' }), note(4, { repository: {} })] });
  r.routes.set(`${API}/repos/o/r/issues/1`, { body: issueBody(1) });
  r.routes.set(`${API}/repos/o/r/issues/2`, { body: issueBody(2) });
  r.source.start();
  await r.fire();
  assert.deepEqual(
    r.events.map((e) => e.externalId),
    ['I_1', 'I_2'],
  );
  const evil = rig();
  evil.routes.set(NOTES, { headers: { link: '<https://evil.test/x>; rel="next"' }, body: [] });
  evil.source.start();
  await evil.fire();
  assert.equal(evil.calls.length, 1);
});

test('pagination is capped, and a failing later page aborts the poll', async () => {
  const r = rig();
  r.routes.set(NOTES, { headers: { link: `<${API}/p>; rel="next"` }, body: [] });
  r.routes.set(`${API}/p`, { headers: { link: `<${API}/p>; rel="next"` }, body: 'not a list' });
  r.source.start();
  await r.fire();
  assert.equal(r.calls.length, 10);
  // 500+ unread: the rest were not read, so the cursor must not claim they were
  assert.equal(r.stored.has('github-notifications:o/r'), false);
  assert.equal(r.timers[0].ms, 60_000);
  const bad = rig();
  bad.routes.set(NOTES, { headers: { link: `<${API}/p>; rel="next"` }, body: [] });
  bad.routes.set(`${API}/p`, { status: 502 });
  bad.source.start();
  await bad.fire();
  assert.equal(bad.statuses.at(-1).state, 'error');
});

test('a deleted or incomplete subject is skipped, and a gone comment list leaves the issue itself', async () => {
  const r = rig();
  r.routes.set(NOTES, {
    body: [note(1), note(2), note(3, {}, { url: 'https://evil.test/i' }), note(4), note(5, {}, { url: undefined }), note(6)],
  });
  r.routes.set(`${API}/repos/o/r/issues/1`, { status: 404 });
  r.routes.set(`${API}/repos/o/r/issues/2`, { body: issueBody(2) });
  r.routes.set(commentsUrl(2), { status: 410 });
  r.routes.set(`${API}/repos/o/r/issues/4`, { body: { node_id: 'I_4' } });
  r.routes.set(`${API}/repos/o/r/issues/6`, { status: 500 });
  r.source.start();
  await r.fire();
  // 1: gone, 3/5: not api urls or no url, 4: incomplete, 2: comment gone so the issue itself, 6: a 5xx is that item's failure only
  assert.deepEqual(
    r.events.map((e) => e.externalId),
    ['I_2'],
  );
  assert.equal(r.statuses.at(-1).state, 'error');
  assert.equal(r.stored.has('github-notifications:o/r'), false);
});

test('a PR emits itself, its comments and its review comments once, with duplicates collapsed', async () => {
  const r = rig();
  const pr = `${API}/repos/o/r/pulls/7`;
  r.routes.set(NOTES, { body: [note(7, {}, { type: 'PullRequest', url: pr })] });
  r.routes.set(pr, { body: { ...issueBody(7), node_id: 'PR_7', html_url: 'https://github.com/o/r/pull/7' } });
  // a PR's own comments are listed under its issue number; one of them is also in the review list (collapsed)
  r.routes.set(commentsUrl(7), { body: [commentBody('IC_p'), commentBody('RC_2', 'alice', 'User', `${API}/repos/o/r/pulls/comments/2`)] });
  r.routes.set(`${pr}/comments?per_page=100&since=${encodeURIComponent(SINCE0)}`, {
    headers: { link: `<${pr}/comments?page=2>; rel="next"` },
    body: [commentBody('RC_2', 'alice', 'User', `${API}/repos/o/r/pulls/comments/2`)],
  });
  r.routes.set(`${pr}/comments?page=2`, { body: [commentBody('RC_3', 'bob', 'User', `${API}/repos/o/r/pulls/comments/3`)] });
  r.source.start();
  await r.fire();
  assert.deepEqual(
    r.events.map((e) => [e.externalId, e.kind, e.threadKey]),
    [
      ['PR_7', 'pull_request.opened', 'PR_7'],
      ['IC_p', 'pull_request.comment', 'PR_7'],
      ['RC_2', 'pull_request.review_comment', 'PR_7'],
      ['RC_3', 'pull_request.review_comment', 'PR_7'],
    ],
  );
});

test('a PR whose review list is gone still emits the PR', async () => {
  const r = rig();
  const pr = `${API}/repos/o/r/pulls/8`;
  r.routes.set(NOTES, { body: [note(8, {}, { type: 'PullRequest', url: pr })] });
  r.routes.set(pr, { body: { ...issueBody(8), node_id: 'PR_8' } });
  r.routes.set(`${pr}/comments?per_page=100&since=${encodeURIComponent(SINCE0)}`, { status: 404 });
  r.source.start();
  await r.fire();
  assert.deepEqual(
    r.events.map((e) => e.kind),
    ['pull_request.opened'],
  );
});

test('bot actors are emitted as Bot; the Superagent’s own login is dropped', async () => {
  const r = rig({ ownLogin: 'mopilot-bot' });
  r.routes.set(NOTES, { body: [note(1), note(2)] });
  r.routes.set(`${API}/repos/o/r/issues/1`, { body: issueBody(1) });
  r.routes.set(`${API}/repos/o/r/issues/2`, { body: issueBody(2) });
  r.routes.set(commentsUrl(1), { body: [commentBody('IC_a', 'dependabot[bot]', 'Bot')] });
  r.routes.set(commentsUrl(2), { body: [commentBody('IC_b', 'mopilot-bot[bot]', 'Bot')] });
  r.source.start();
  await r.fire();
  assert.deepEqual(
    r.events.map((e) => [e.externalId, e.actor.type]),
    [
      ['I_1', 'User'],
      ['IC_a', 'Bot'],
      ['I_2', 'User'],
    ],
  );
});

test('a duplicate delivery across polls gives the same externalId', async () => {
  const r = rig();
  r.routes.set(NOTES, { body: [note(1)] });
  r.routes.set(`${API}/repos/o/r/issues/1`, { body: issueBody(1) });
  r.routes.set(commentsUrl(1), { body: [commentBody('IC_same')] });
  r.source.start();
  await r.fire();
  await r.fire();
  assert.deepEqual(
    r.events.map((e) => e.externalId),
    ['I_1', 'IC_same', 'I_1', 'IC_same'],
    'the same ids each poll, so the log keeps each once',
  );
});

test('the token reader prefers the environment, else gh, else null', async () => {
  const calls: any[] = [];
  const exec = async (f: string, a: string[], o: any) => (calls.push([f, a, o.env]), { stdout: ' ghtok\n' });
  const childEnv = () => ({ PATH: 'p' });
  assert.equal(await src.ghTokenReader({ exec, childEnv, env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'envtok' } })(), 'envtok');
  assert.equal(calls.length, 0);
  assert.equal(await src.ghTokenReader({ exec, childEnv, env: {} })(), 'ghtok');
  assert.deepEqual(calls, [['gh', ['auth', 'token'], { PATH: 'p' }]]);
  assert.equal(await src.ghTokenReader({ exec: async () => ({}), childEnv, env: {} })(), null);
});

test('a throwing status listener is logged and polling goes on', async () => {
  const logs: string[] = [];
  const t: any[] = [];
  const make = (log?: (m: string) => void) =>
    src.createGithubSource({
      repo: 'o/r',
      fetch: async () => ({ status: 304, ok: false, headers: { get: () => null } }),
      now: () => 0,
      setTimer: (fn: any) => t.push(fn),
      clearTimer: () => {},
      getToken: async () => 't',
      store: { get: () => ({ pollMs: 60_000 }), set: () => {} },
      emit: () => {},
      log,
      onStatus: () => {
        throw new Error('listener');
      },
    });
  make((m) => logs.push(m)).start();
  await t.pop()();
  assert.equal(logs.length, 1);
  assert.equal(t.length, 1);
  // without a logger the failure is dropped, never thrown
  make().start();
  await t.pop()();
  assert.equal(t.length, 2);
});

test('one notification whose emit is refused does not hide the others, and the window is read again', async () => {
  const r = rig({ emitFails: (e) => e.externalId === 'I_1' });
  r.routes.set(NOTES, { headers: { etag: 'e' }, body: [note(1), note(2)] });
  r.routes.set(`${API}/repos/o/r/issues/1`, { body: issueBody(1) });
  r.routes.set(`${API}/repos/o/r/issues/2`, { body: issueBody(2) });
  r.source.start();
  await r.fire();
  assert.deepEqual(
    r.events.map((e) => e.externalId),
    ['I_2'],
  );
  assert.equal(r.stored.has('github-notifications:o/r'), false);
  assert.equal(r.statuses.at(-1).state, 'error');
  assert.equal(r.timers[0].ms, 30_000);
  assert.equal(r.logs.length, 1);
});

test('a limit on one item still ends the poll', async () => {
  const r = rig();
  r.routes.set(NOTES, { body: [note(1), note(2)] });
  r.routes.set(`${API}/repos/o/r/issues/1`, { status: 429, headers: { 'retry-after': '9' } });
  r.source.start();
  await r.fire();
  assert.equal(r.calls.length, 2);
  assert.equal(r.timers[0].ms, 9000);
});

test('a token reader that rejects backs off like a missing sign-in', async () => {
  const r = rig({
    getToken: async () => {
      throw new Error('gh not found');
    },
  });
  r.source.start();
  await r.fire();
  assert.equal(r.timers[0].ms, 300_000);
  assert.equal(r.calls.length, 0);
  // and one that rejects after stop() reports nothing
  let reject!: () => void;
  const q = rig({ getToken: () => new Promise((_, rej) => (reject = () => rej(new Error('late')))) });
  q.source.start();
  const done = q.fire();
  await waitFor(() => reject, 'the token read to be pending');
  q.source.stop();
  reject();
  await done;
  assert.deepEqual(q.statuses, []);
  assert.equal(q.timers.length, 0);
});

test('requests refuse redirects so the token never leaves api.github.com', async () => {
  const seen: any[] = [];
  const t: any[] = [];
  const s = src.createGithubSource({
    repo: 'o/r',
    fetch: async (_u: string, init: any) => (seen.push(init.redirect), { status: 304, ok: false, headers: { get: () => null } }),
    now: () => 0,
    setTimer: (fn: any) => t.push(fn),
    clearTimer: () => {},
    getToken: async () => 't',
    store: { get: () => undefined, set: () => {} },
    emit: () => {},
  });
  s.start();
  await t.pop()();
  assert.deepEqual(seen, ['error']);
});

test('a review list that fails with a 5xx is that item’s failure; an unexpected error uses the plain backoff', async () => {
  const r = rig();
  const pr = `${API}/repos/o/r/pulls/7`;
  r.routes.set(NOTES, { body: [note(7, {}, { type: 'PullRequest', url: pr })] });
  r.routes.set(pr, { body: { ...issueBody(7), node_id: 'PR_7' } });
  r.routes.set(`${pr}/comments?per_page=100&since=${encodeURIComponent(SINCE0)}`, { status: 500 });
  r.source.start();
  await r.fire();
  assert.deepEqual(
    r.events.map((e) => e.kind),
    ['pull_request.opened'],
  );
  assert.equal(r.statuses.at(-1).state, 'error');
  const timers: any[] = [];
  const s = src.createGithubSource({
    repo: 'o/r',
    fetch: async () => assert.fail('no fetch'),
    now: () => 0,
    setTimer: (fn: any, ms: number) => timers.push({ fn, ms }),
    clearTimer: () => {},
    getToken: async () => 't',
    store: {
      get: () => {
        throw new Error('disk');
      },
      set: () => {},
    },
    emit: () => {},
  });
  s.start();
  await timers.pop().fn();
  assert.equal(timers[0].ms, 30_000);
});
