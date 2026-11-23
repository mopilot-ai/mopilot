// Pure half of the Superagent GitHub source: header math and payload normalization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import n from '../electron/superagent/sources/githubNotifications.cjs';

const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });

test('poll interval honors X-Poll-Interval but never goes under a minute', () => {
  assert.equal(n.pollIntervalMs(h({})), null);
  assert.equal(n.pollIntervalMs(h({ 'x-poll-interval': 'x' })), null);
  assert.equal(n.pollIntervalMs(h({ 'x-poll-interval': '-1' })), null);
  assert.equal(n.pollIntervalMs(h({ 'x-poll-interval': '' })), null);
  assert.equal(n.pollIntervalMs(h({ 'x-poll-interval': '30' })), 60_000);
  assert.equal(n.pollIntervalMs(h({ 'x-poll-interval': '120' })), 120_000);
});

test('rate limit delay: Retry-After, then primary reset, then growing secondary minute', () => {
  assert.equal(n.rateLimitDelayMs(h({ 'retry-after': '7' }), 0, 1), 7000);
  assert.equal(n.rateLimitDelayMs(h({ 'retry-after': '0' }), 0, 1), 1000);
  assert.equal(n.rateLimitDelayMs(h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' }), 40_000, 1), 60_000);
  assert.equal(n.rateLimitDelayMs(h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' }), 40_000, 1), 1000);
  assert.equal(n.rateLimitDelayMs(h({ 'x-ratelimit-remaining': '0' }), 0, 1), 60_000);
  assert.equal(n.rateLimitDelayMs(h({ 'x-ratelimit-remaining': '4' }), 0, 2), 120_000);
  assert.equal(n.rateLimitDelayMs(h({}), 0, 0), 60_000);
  assert.equal(n.rateLimitDelayMs(h({}), 0, 20), 15 * 60_000);
});

test('failure delay doubles and caps', () => {
  assert.equal(n.failureDelayMs(30_000, 1), 30_000);
  assert.equal(n.failureDelayMs(30_000, 3), 120_000);
  assert.equal(n.failureDelayMs(30_000, 0), 30_000);
  assert.equal(n.failureDelayMs(30_000, 30), 15 * 60_000);
});

test('next link is found among several rels, or null', () => {
  assert.equal(n.nextLink(h({})), null);
  assert.equal(n.nextLink(h({ link: '<https://x/1>; rel="prev", <https://x/3>; rel="next"' })), 'https://x/3');
  assert.equal(n.nextLink(h({ link: '<https://x/1>; rel="prev"' })), null);
});

test('only api.github.com urls receive the token', () => {
  assert.ok(n.isApiUrl('https://api.github.com'));
  assert.ok(n.isApiUrl('https://api.github.com/repos/a/b'));
  assert.ok(!n.isApiUrl('https://api.github.com.evil.test/x'));
  assert.ok(!n.isApiUrl(5));
});

test('own actor matches with or without [bot], case-insensitively; unset never matches', () => {
  assert.ok(n.isOwnActor({ login: 'Mopilot-Bot[bot]' }, 'mopilot-bot'));
  assert.ok(n.isOwnActor({ login: 'mopilot-bot' }, 'mopilot-bot[bot]'));
  assert.ok(!n.isOwnActor({ login: 'someone' }, 'mopilot-bot'));
  assert.ok(!n.isOwnActor({ login: 'someone' }, undefined));
});

const repo = { nodeId: 'R_1', fullName: 'o/r' };
const issue = {
  node_id: 'I_1',
  number: 3,
  html_url: 'https://github.com/o/r/issues/3',
  created_at: '2026-01-01T00:00:00Z',
  body: 'hi',
  user: { login: 'a', id: 9, type: 'User' },
};

test('subject, repo and type validation', () => {
  assert.deepEqual(n.subjectOf(issue, 'issue'), { type: 'issue', nodeId: 'I_1', number: 3, url: issue.html_url });
  assert.equal(n.subjectOf(null, 'issue'), null);
  assert.equal(n.subjectOf({ ...issue, number: 'x' }, 'issue'), null);
  assert.deepEqual(n.repoOf({ node_id: 'R_1', full_name: 'o/r' }), repo);
  assert.equal(n.repoOf({}), null);
  assert.equal(n.subjectType('Issue'), 'issue');
  assert.equal(n.subjectType('PullRequest'), 'pull_request');
  assert.equal(n.subjectType('Release'), null);
});

test('opened event for an issue and a PR, with the exact shape', () => {
  const s = n.subjectOf(issue, 'issue');
  assert.deepEqual(n.openedEvent(issue, s, repo), {
    source: 'github',
    externalId: 'I_1',
    threadKey: 'I_1',
    kind: 'issue.opened',
    actor: { login: 'a', id: 9, type: 'User' },
    repo,
    subject: s,
    body: 'hi',
    occurredAt: '2026-01-01T00:00:00Z',
  });
  const p = n.subjectOf(issue, 'pull_request');
  assert.equal(n.openedEvent({ ...issue, body: null }, p, repo)?.kind, 'pull_request.opened');
  assert.equal(n.openedEvent({ ...issue, body: null }, p, repo)?.body, '');
  assert.equal(n.openedEvent({}, p, repo), null);
});

test('comment kinds and actors: bots keep their type, missing users become ghost', () => {
  const s = n.subjectOf(issue, 'issue');
  const p = n.subjectOf(issue, 'pull_request');
  const c = {
    node_id: 'IC_1',
    created_at: 't',
    body: 'b',
    url: 'https://api.github.com/repos/o/r/issues/comments/1',
    user: { login: 'bot[bot]', id: 2, type: 'Bot' },
  };
  assert.equal(n.commentEvent(c, s, repo)?.kind, 'issue.comment');
  assert.equal(n.commentEvent(c, p, repo)?.kind, 'pull_request.comment');
  assert.deepEqual(n.commentEvent(c, s, repo)?.actor, { login: 'bot[bot]', id: 2, type: 'Bot' });
  const r = n.commentEvent({ ...c, url: 'https://api.github.com/repos/o/r/pulls/comments/1', user: null, body: 5 }, p, repo);
  assert.equal(r?.kind, 'pull_request.review_comment');
  assert.deepEqual(r?.actor, { login: 'ghost', id: 0, type: 'User' });
  assert.equal(r?.body, '');
  assert.deepEqual(n.commentEvent({ ...c, user: { login: 'x', id: 'n', type: 3 }, url: undefined }, s, repo)?.actor, {
    login: 'x',
    id: 0,
    type: 'User',
  });
  assert.equal(n.commentEvent({}, s, repo), null);
});
