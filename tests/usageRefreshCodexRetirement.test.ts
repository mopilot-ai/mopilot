// Codex quota/reset reads retire with their login, preserving current push figures and authentication retry ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, sub, chatgptAuth, flush, codex } from './support/electron-accounts.ts';
import { controlledReads, deferred, tick } from './support/async-scenarios.ts';

const snap = (usedPercent: number) => ({ rateLimits: { primary: { usedPercent } } });
const fixture = (t: any) => setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.test' } });

for (const order of ['old-first', 'fresh-first'] as const) {
  for (const fail of [false, true]) {
    test(`Codex replacement keeps its quota/error when old ${fail ? 'failure' : 'success'} settles ${order}`, async (t) => {
      const { a } = fixture(t);
      const row = a.get('b');
      row.limits = null;
      const reads = controlledReads<any>();
      a.readUsage = reads.read;
      const old = a.refreshUsage(['b'], 'now');
      await tick();
      a.forgetUsage(row);
      row.email = 'replacement@example.test';
      const fresh = a.refreshUsage(['b'], 'now');
      await tick();
      assert.equal(reads.requests.length, 2);
      const settleOld = () => (fail ? reads.requests[0].reject(new Error('old login failed')) : reads.requests[0].resolve(snap(99)));
      if (order === 'old-first') {
        settleOld();
        await old;
        assert.equal(row.limits, null);
      }
      reads.requests[1].resolve(snap(7));
      await fresh;
      if (order === 'fresh-first') settleOld();
      await old;
      assert.equal(row.limits.used, 7);
      assert.equal(row.error, undefined);
      assert.equal(a.usageRefresh.retryAt('b'), null);
    });
  }
}

test('a newer push still wins over a current Codex poll after a sign-in', async (t) => {
  const { a } = fixture(t);
  const row = a.get('b');
  a.forgetUsage(row);
  const reads = controlledReads<any>();
  a.readUsage = reads.read;
  const fresh = a.refreshUsage(['b'], 'now');
  await tick();
  const push = { used: 3, at: Date.now() };
  row.limits = push;
  reads.requests[0].resolve(snap(7));
  await fresh;
  assert.equal(row.limits, push);
});

test('a reset-card read cannot publish quota after the same account record is signed in again', async (t) => {
  const { a } = fixture(t);
  const row = a.get('b');
  row.limits = null;
  const reads = controlledReads<any>();
  a.readUsage = reads.read;
  const old = a.resetCredits('b');
  a.forgetUsage(row);
  reads.requests[0].resolve(snap(99));
  await assert.rejects(old, /login changed during its reset-card read/, 'the renderer must not receive stale quota or details');
  assert.equal(row.limits, null);
  const fresh = a.resetCredits('b');
  reads.requests[1].resolve(snap(7));
  await fresh;
  assert.equal(row.limits.used, 7);
});

test('a retired quota read starts no authentication refresh or retry; a current failure still does', async (t) => {
  const { a } = fixture(t);
  const row = a.get('b');
  const calls = controlledReads<any>();
  const refreshing = deferred<any>();
  let refreshes = 0;
  a.sidecar = () => ({ call: calls.read });
  a.refresh = () => (refreshes++, refreshing.promise);
  const old = a.readUsage(row);
  const rejection = assert.rejects(old, /401/);
  a.forgetUsage(row);
  calls.requests[0].reject(new Error('401 old login'));
  await rejection;
  assert.equal(refreshes, 0);
  const current = a.readUsage(row);
  const currentRejection = assert.rejects(current, /401/);
  calls.requests[1].reject(new Error('401 current login'));
  await tick();
  assert.equal(refreshes, 1);
  a.forgetUsage(row);
  refreshing.resolve({});
  await currentRejection;
  assert.equal(calls.requests.length, 2, 'a refresh already started does not schedule a retired retry');
});

test('a token refresh started by an old usage failure cannot expire the replacement login', async (t) => {
  const { a } = fixture(t);
  const row = a.get('b');
  row.limits = null;
  const refreshing = deferred<any>();
  let quotaCalls = 0;
  let refreshes = 0;
  a.sidecar = () => ({
    call: (method: string) => {
      if (method === 'account/read') return refreshes++, refreshing.promise;
      if (++quotaCalls === 1) return Promise.reject(new Error('401 unauthorized'));
      return Promise.resolve(snap(7));
    },
  });
  const old = a.refreshUsage(['b'], 'now');
  await tick();
  assert.equal(refreshes, 1);
  a.forgetUsage(row);
  await a.refreshUsage(['b'], 'now');
  refreshing.resolve({ account: null });
  await old;
  assert.equal(row.status, 'ok');
  assert.equal(row.error, undefined);
  assert.equal(row.limits.used, 7);
});

test('replacement token refresh owns coalescing and cleanup while the old refresh settles', async (t) => {
  const { a } = fixture(t);
  const row = a.get('b');
  const replies = controlledReads<any>();
  a.sidecar = () => ({ call: replies.read });
  const old = a.refresh(row);
  const rejected = assert.rejects(old, /login changed/);
  a.forgetUsage(row);
  const fresh = a.refresh(row);
  assert.equal(replies.requests.length, 2);
  replies.requests[0].resolve({ account: null });
  await rejected;
  assert.equal(a.refresh(row), fresh, 'retired finalizer keeps the current token refresh');
  replies.requests[1].resolve({ account: { planType: 'team' } });
  await fresh;
  assert.equal(row.planType, 'team');
  assert.equal(a.refreshing.size, 0);
});

for (const phase of ['active-success', 'active-error', 'fallback-success', 'fallback-error', 'candidate-replaced'] as const) {
  test(`retired token recovery cannot switch or answer for a fresh sign-in: ${phase}`, async (t) => {
    const { a } = setup(t, { state: { active: 'a', accounts: [sub('a'), sub('b')] }, homes: { a: 'a@example.test', b: 'b@example.test' } });
    a.state.active = 'a';
    a.candidates = () => [a.get('b')];
    const replies: any[] = [];
    a.server.send = (reply: any) => replies.push(reply);
    const pending = deferred<any>();
    a.tokens = (row: any) =>
      (row.id === 'a' && phase.startsWith('fallback')) || (row.id === 'a' && phase === 'candidate-replaced')
        ? Promise.reject(new Error('expired'))
        : pending.promise;
    const work = a.answerRefresh({ id: 42 });
    await tick();
    a.forgetUsage(a.get(phase === 'candidate-replaced' ? 'b' : 'a'));
    if (phase.endsWith('error')) pending.reject(new Error('old token failed'));
    else pending.resolve({ accessToken: 'fake-old', chatgptAccountId: 'old' });
    await work;
    assert.equal(a.state.active, 'a');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].result, undefined, 'no retired token is returned to main');
    assert.ok(replies[0].error);
  });
}

test('installing a sign-in retires quota and token work before apply awaits the replacement', async (t) => {
  const { a } = fixture(t);
  const row = a.get('b');
  row.chatgptAccountId = 'acct-b';
  row.email = 'b@example.test';
  row.limits = null;
  const reads = controlledReads<any>();
  a.sidecar = () => ({ call: reads.read });
  const oldToken = a.refresh(row);
  const oldRejection = assert.rejects(oldToken, { code: 'ACCOUNT_CHANGED' });
  const oldQuota = a.refreshUsage(['b'], 'now');
  await tick();
  const applying = deferred<any>();
  let installed = false;
  a.apply = () => {
    installed = true;
    return applying.promise;
  };
  codex.handle = (method) =>
    method === 'account/read' ? { account: { email: 'b@example.test' } } : { loginId: 'login', authUrl: 'https://login.test' };
  await a.startLogin('b');
  const login = a.loginRun;
  chatgptAuth(login.staging, 'b@example.test', 'acct-b');
  const finishing = a.finishLogin(login, { success: true });
  await flush(15);
  assert.equal(installed, true);
  reads.requests[0].resolve({ account: null });
  reads.requests[1].resolve(snap(99));
  await Promise.all([oldRejection, oldQuota]);
  assert.equal(row.status, 'ok');
  assert.equal(row.limits, null);
  applying.resolve({});
  await finishing;
  await tick();
  reads.requests[2].resolve(snap(7));
  await tick();
  assert.equal(row.limits.used, 7);
});

for (const consumer of ['applyNow', 'chatgptHeaders'] as const) {
  test(`${consumer} cannot dispatch a token retired before its awaiting continuation`, async (t) => {
    const { a, sent } = fixture(t);
    a.state.active = 'b';
    a.applied = null;
    a.mainMode = 'external';
    a.tokens = async () => ({ accessToken: 'fake-old', chatgptAccountId: 'old' });
    const pending = a[consumer]();
    a.usageRefresh.clear('b');
    if (consumer === 'applyNow') {
      await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
      assert.equal(sent.filter((m: any) => m.method === 'account/login/start').length, 0);
    } else assert.equal(await pending, null);
  });
}
