// bench/lib/mgb/tasks/drive.mjs (#1381): the oracle's browser on the fixture apps: urlencoded and multipart posts,
// a cookie jar for the signed-in site, mail an app sends, and an error page as a thrown task bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ORACLE_NOW, browse } = await import('../bench/lib/mgb/tasks/drive.mjs');
const { loadFixtures } = await import('../bench/lib/mgb/apps/index.mjs');
const { magicPath } = await import('../bench/lib/mgb/apps/account.mjs');

const fixtures = () =>
  loadFixtures({
    mail: { user: { name: 'Ada Abara', email: 'ada@corp.test' }, messages: [{ from: 'b@x.test', subject: 'Hi', body: 'x' }] },
    tracker: {
      user: { name: 'Ada Abara' },
      project: { key: 'AP', name: 'AP' },
      members: ['Ada Abara'],
      labels: ['invoice', 'urgent'],
      issues: [],
    },
    account: { secret: 'acct-secret-1', owner: { name: 'Ada', email: 'ada@corp.test' }, password: 'not-in-any-task-xyz', activity: [] },
  });

test('browse posts forms and uploads through the apps, at the oracle clock', () => {
  const state = fixtures();
  const tracker = browse(state, 'tracker');
  const r = tracker.post('/issues', {
    fields: { title: 'One', body: 'b', priority: 'high', labels: 'invoice' },
    files: [
      { field: 'attach', name: 'a.png', type: 'image/png', content: Buffer.from([1]) },
      { field: 'attach', name: 'b.txt', content: 'hi' },
    ],
  });
  assert.equal(r.status, 303);
  const issue = state.tracker.issues[0];
  assert.deepEqual(
    [issue.title, issue.priority, issue.labels, issue.attachments.map((a: any) => [a.name, a.type])],
    [
      'One',
      'high',
      ['invoice'],
      [
        ['a.png', 'image/png'],
        ['b.txt', 'application/octet-stream'],
      ],
    ],
  );
  assert.equal(state.tracker.events[0].at, ORACLE_NOW);
  tracker.post('/issues', { title: 'Two', priority: 'low', labels: ['invoice', 'urgent'] });
  assert.deepEqual(state.tracker.issues[1].labels, ['invoice', 'urgent']);
  assert.equal(tracker.get('/issues').status, 200);
  assert.equal(browse(state, 'mail', 5).post('/compose', { to: 'b@x.test' }).status, 303);
  assert.equal(state.mail.events.at(-1).at, 5);
});

test('browse keeps cookies like a browser, and delivers mail an app sends', () => {
  const state = fixtures();
  const acct = browse(state, 'account');
  assert.equal(acct.get('/settings').headers.location, '/login?next=%2Fsettings', 'no session yet');
  acct.get(magicPath('acct-secret-1'));
  assert.equal(acct.get('/settings').status, 200);
  acct.post('/security', { recoveryEmail: 'new@home.test' });
  assert.equal(state.mail.messages.at(-1).from.email, 'no-reply@account.localhost');
  // another browse is another browser: no session
  assert.equal(browse(state, 'account').get('/settings').status, 303);
});

test('an error page is a task bug: browse throws with the page alert', () => {
  const state = fixtures();
  assert.throws(
    () => browse(state, 'tracker').post('/issues', { title: '', priority: 'low' }),
    /POST tracker\/issues answered 422: Title is required\./,
  );
  assert.throws(() => browse(state, 'tracker').get('/issues/AP-99'), /GET tracker\/issues\/AP-99 answered 404: No such issue/);
  assert.throws(() => browse(state, 'shop'), /no loaded app shop/);
  assert.throws(() => browse(state, 'bank'), /no loaded app bank/);
});
