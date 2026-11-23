// Superagent GitHub source and notifications the person has already read (opened on github.com or the phone): they must still be seen.
// The fake serves the real API's unread-only default, so a poll that does not ask for read notifications gets nothing, as it did against the real repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  API,
  NOTES,
  SINCE0,
  notesUrl,
  commentsUrl,
  note,
  issueBody,
  commentBody,
  rig,
  notificationsApi,
  repository,
} from './support/superagentGithubRig.ts';

const NOTIFICATIONS = `${API}/repos/o/r/notifications`;
// the rig's clock is 10_000 ms: the notifications below are far newer than any first-poll window
const read = (n: number, extra: any = {}, subject: any = {}) =>
  note(n, { unread: false, updated_at: '2026-11-08T11:30:00Z', ...extra }, subject);

test('a read notification with a new comment is emitted: the poll asks for read ones too', async () => {
  const r = rig();
  r.serve(NOTIFICATIONS, notificationsApi([read(1)]));
  r.routes.set(`${API}/repos/o/r/issues/1`, { body: issueBody(1) });
  r.routes.set(commentsUrl(1), { body: [commentBody('IC_1')] });
  r.source.start();
  await r.fire();
  assert.deepEqual(
    r.events.filter((e) => e.kind === 'issue.comment').map((e) => e.externalId),
    ['IC_1'],
  );
});

test('review comments newer than our own mark are listed even when the thread was read after one of them', async () => {
  // our mark says everything up to 11:00 was handled; the app was closed since. A review comment came at 11:30, the person
  // read the thread at 11:45 (so last_read_at is later than it), and a second one at 11:50 made the thread unread again
  const r = rig({ cursor: { since: '2026-11-08T11:00:00Z' } });
  const pr = `${API}/repos/o/r/pulls/5`;
  const thread = note(
    5,
    { unread: true, updated_at: '2026-11-08T11:50:00Z', last_read_at: '2026-11-08T11:45:00Z' },
    { type: 'PullRequest', url: pr },
  );
  r.serve(NOTIFICATIONS, notificationsApi([thread]));
  r.routes.set(pr, { body: { ...issueBody(5), node_id: 'P_5' } });
  const review = (id: string, at: string) => ({
    ...commentBody(id, 'alice', 'User', `${API}/repos/o/r/pulls/comments/${id}`),
    updated_at: at,
  });
  const reviews = [review('RC_1', '2026-11-08T11:30:00Z'), review('RC_2', '2026-11-08T11:50:00Z')];
  // the review list as the real API serves it: comments updated after `since`
  r.serve(`${pr}/comments`, (params) => ({
    body: reviews.filter((c) => !params.get('since') || Date.parse(c.updated_at) > Date.parse(params.get('since')!)),
  }));
  r.source.start();
  await r.fire();
  assert.deepEqual(
    r.events
      .filter((e) => e.kind === 'pull_request.review_comment')
      .map((e) => e.externalId)
      .sort(),
    ['RC_1', 'RC_2'],
  );
});

test('the fake answers as GitHub does: unread only unless all=true, and only what changed after since', () => {
  const api = notificationsApi([
    { unread: true, updated_at: '2026-01-02T00:00:00Z' },
    { unread: false, updated_at: '2026-01-03T00:00:00Z' },
  ]);
  assert.equal(api(new URLSearchParams('')).body.length, 1);
  assert.equal(api(new URLSearchParams('all=true')).body.length, 2);
  assert.equal(api(new URLSearchParams('all=true&since=2026-01-02T12:00:00Z')).body.length, 1);
  assert.equal(repository.full_name, 'o/r');
});

test('the first poll asks for read notifications too, and only the last hour, so a new install does not backfill', async () => {
  const r = rig();
  r.routes.set(NOTES, { status: 304 });
  r.source.start();
  await r.fire();
  assert.equal(r.calls[0].url, `${API}/repos/o/r/notifications?all=true&per_page=50&since=1969-12-31T23%3A00%3A10Z`);
  assert.equal(r.calls.length, 1);
  assert.ok(r.calls.every((c) => c.method === 'GET'));
});

test('our own mark: it follows the newest update seen, never moves back, and the validators belong to the window they were answered for', async () => {
  const r = rig();
  const list = [
    read(1, { updated_at: '2026-11-08T11:20:00Z' }),
    read(2, { updated_at: '2026-11-08T11:30:00Z' }),
    read(3, { updated_at: 'garbage' }),
  ];
  r.serve(NOTIFICATIONS, (params) => ({ ...notificationsApi(list)(params), headers: { etag: 'e-A', 'last-modified': 'lm-A' } }));
  for (const n of [1, 2, 3]) r.routes.set(`${API}/repos/o/r/issues/${n}`, { body: issueBody(n) });
  r.source.start();
  await r.fire();
  // the newest update, a second behind so one stamped in the same second is not missed
  assert.deepEqual(r.stored.get('github-notifications:o/r'), {
    since: '2026-11-08T11:29:59Z',
    etag: 'e-A',
    lastModified: 'lm-A',
    etagFor: SINCE0,
    pollMs: 60_000,
  });
  // the next poll is for the moved window: another list, so no validators
  r.routes.set(notesUrl('2026-11-08T11:29:59Z'), { status: 304 });
  await r.fire();
  assert.equal(r.calls.at(-1)!.url, notesUrl('2026-11-08T11:29:59Z'));
  assert.equal(r.calls.at(-1)!.headers['if-none-match'], undefined);
  // the window did not move (nothing newer): the validators saved for it are sent again
  r.stored.set('github-notifications:o/r', { since: '2026-11-08T11:29:59Z', etag: 'e-B', etagFor: '2026-11-08T11:29:59Z', pollMs: 60_000 });
  await r.fire();
  assert.equal(r.calls.at(-1)!.headers['if-none-match'], 'e-B');
  // a notification older than the mark (a late one) never moves it back
  const start = '2026-11-08T11:29:59Z';
  r.stored.set('github-notifications:o/r', { since: start });
  r.routes.set(notesUrl(start), { body: [read(4, { updated_at: '2026-11-08T10:00:00Z' })] });
  r.routes.set(`${API}/repos/o/r/issues/4`, { body: issueBody(4) });
  await r.fire();
  assert.equal(r.stored.get('github-notifications:o/r').since, start);
});

test('a poll that finds nothing keeps the window it asked for; an older cursor or a garbled one starts a fresh window', async () => {
  const r = rig();
  r.routes.set(NOTES, { body: [] });
  r.source.start();
  await r.fire();
  assert.equal(r.stored.get('github-notifications:o/r').since, SINCE0);
  // a cursor from before the mark existed: its validators are for another list and are not sent
  r.stored.set('github-notifications:o/r', { etag: 'old', lastModified: 'old-lm', pollMs: 60_000 });
  await r.fire();
  assert.equal(r.calls.at(-1)!.url, NOTES);
  assert.equal(r.calls.at(-1)!.headers['if-none-match'], undefined);
  assert.equal(r.calls.at(-1)!.headers['if-modified-since'], undefined);
  r.stored.set('github-notifications:o/r', { since: 'not a time', etag: 'old', etagFor: 'not a time' });
  await r.fire();
  assert.equal(r.calls.at(-1)!.url, NOTES);
});

test('50 read notifications seen again after a lost cursor become each event once in the log', async () => {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite');
  const { createStore } = require('../electron/superagent/store/index.cjs');
  const { migrate } = require('../electron/superagent/store/migrations.cjs');
  const { createIntake } = require('../electron/superagent/intake/intake.cjs');
  const { saveConfig } = require('../electron/superagent/gate/config.cjs');
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const store = createStore({ db, now: () => 1000 });
  saveConfig(store, { repo: 'o/r', allowed: ['alice'] });
  const intake = createIntake({ store, now: () => 1000 });

  const r = rig();
  const all = Array.from({ length: 50 }, (_, i) => read(i + 1, { updated_at: `2026-11-08T11:${String(i).padStart(2, '0')}:00Z` }));
  r.serve(NOTIFICATIONS, notificationsApi(all));
  for (let i = 1; i <= 50; i++) r.routes.set(`${API}/repos/o/r/issues/${i}`, { body: issueBody(i) });
  r.source.start();
  await r.fire();
  const first = r.events.length;
  assert.equal(first, 50);
  for (const e of r.events) await intake.receive(e);
  // the cursor is lost (a new install of the database, a restore): the same 50 come again
  r.stored.clear();
  r.events.length = 0;
  await r.fire();
  assert.equal(r.events.length, 50, 'the source repeats them');
  const statuses: string[] = [];
  for (const e of r.events) statuses.push((await intake.receive(e)).status);
  assert.equal(
    statuses.every((x) => x === 'duplicate'),
    true,
  );
  const count = (t: string) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  assert.deepEqual([count('events'), count('triggers'), count('decisions')], [50, 50, 50]);
});

// the issue comments of a thread as the real API serves them: oldest first, those updated after `since`
const comment = (id: string, at: string, login = 'alice') => ({
  ...commentBody(id, login, 'User', `${API}/repos/o/r/issues/comments/${id}`),
  updated_at: at,
});
const issueComments = (list: any[]) => (params: URLSearchParams) => ({
  body: list.filter((c) => !params.get('since') || Date.parse(c.updated_at) > Date.parse(params.get('since')!)),
});

test('three comments between two polls produce three events, not just the latest; a replay produces none new', async () => {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite');
  const { createStore } = require('../electron/superagent/store/index.cjs');
  const { migrate } = require('../electron/superagent/store/migrations.cjs');
  const { createIntake } = require('../electron/superagent/intake/intake.cjs');
  const { saveConfig } = require('../electron/superagent/gate/config.cjs');
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const store = createStore({ db, now: () => 1000 });
  saveConfig(store, { repo: 'o/r', allowed: ['alice'] });
  const intake = createIntake({ store, now: () => 1000 });

  const r = rig({ cursor: { since: '2026-11-08T11:00:00Z' } });
  const comments = [
    comment('IC_1', '2026-11-08T11:10:00Z'),
    comment('IC_2', '2026-11-08T11:20:00Z'),
    comment('IC_3', '2026-11-08T11:30:00Z'),
  ];
  // the notification names only the newest comment
  const thread = read(1, { updated_at: '2026-11-08T11:30:00Z' }, { latest_comment_url: `${API}/repos/o/r/issues/comments/IC_3` });
  r.serve(NOTIFICATIONS, notificationsApi([thread]));
  r.routes.set(`${API}/repos/o/r/issues/1`, { body: { ...issueBody(1), created_at: '2026-01-02T00:00:00Z' } });
  r.routes.set(`${API}/repos/o/r/issues/comments/IC_3`, { body: comments[2] });
  r.serve(`${API}/repos/o/r/issues/1/comments`, issueComments(comments));
  r.source.start();
  await r.fire();
  assert.deepEqual(
    r.events.filter((e) => e.kind === 'issue.comment').map((e) => e.externalId),
    ['IC_1', 'IC_2', 'IC_3'],
  );
  for (const e of r.events) assert.equal((await intake.receive(e)).status, 'recorded');
  // the same window read again (a lost cursor): the source repeats them, the log takes none
  r.stored.set('github-notifications:o/r', { since: '2026-11-08T11:00:00Z' });
  r.events.length = 0;
  await r.fire();
  const again: string[] = [];
  for (const e of r.events) again.push((await intake.receive(e)).status);
  assert.equal(again.length, 3);
  assert.equal(
    again.every((s) => s === 'duplicate'),
    true,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 3);
});
