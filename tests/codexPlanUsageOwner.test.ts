// Codex's unpooled plan limits follow the login that was current when the renderer requested them.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from './support/async-scenarios.ts';
import { bootImpls, callsOf, flush, impl, loadStore, resetAll } from './support/store-harness.ts';

const { store, resetState } = await loadStore();
const { connect, onCodexStatus, refreshAccount, refreshRateLimits } = await import('../src/store/connection.ts');
const { getState, setState } = store.useStore;
const login = (email: string) => ({ type: 'chatgpt', email, planType: 'plus' }) as const;
const limits = (n: number) => ({ rateLimits: { primary: { usedPercent: n } }, rateLimitsByLimitId: null }) as any;

beforeEach(() => {
  resetState();
  resetAll();
  bootImpls();
});

test('a changed login clears the displayed limits and prevents a retired read from publishing', async () => {
  setState({ conn: 'ready', account: login('a@example.com'), rateLimits: limits(75) });
  const old = deferred();
  impl['api.accountRateLimits'] = () => old.promise;
  const pending = refreshRateLimits();
  impl['api.accountRead'] = async () => ({ account: login('b@example.com'), requiresOpenaiAuth: false });
  const next = deferred();
  impl['api.accountRateLimits'] = () => next.promise;
  await refreshAccount();
  assert.deepEqual(getState().account, login('b@example.com'));
  assert.equal(getState().rateLimits, null);
  old.resolve(limits(99));
  await pending;
  assert.equal(getState().rateLimits, null);
  next.resolve(limits(20));
  await next.promise;
  await Promise.resolve();
  assert.deepEqual(getState().rateLimits, limits(20));
});

test('two overlapping account reads cannot put a previous login back', async () => {
  setState({ account: login('a@example.com'), rateLimits: limits(75) });
  const old = deferred();
  impl['api.accountRead'] = () => old.promise;
  const pending = refreshAccount();
  impl['api.accountRead'] = async () => ({ account: login('b@example.com'), requiresOpenaiAuth: false });
  await refreshAccount();
  old.resolve({ account: login('a@example.com'), requiresOpenaiAuth: false });
  await pending;
  assert.deepEqual(getState().account, login('b@example.com'));
  assert.equal(getState().rateLimits, null);
});

test('rereading the same login with optional metadata omitted preserves its quota', async () => {
  setState({ account: { type: 'chatgpt', email: null }, rateLimits: limits(35) });
  impl['api.accountRead'] = async () => ({ account: { type: 'chatgpt' }, requiresOpenaiAuth: false });
  await refreshAccount();
  assert.deepEqual(getState().rateLimits, limits(35));
});

test('the latest quota read wins in either order', async () => {
  for (const early of [false, true]) {
    const old = deferred();
    impl['api.accountRateLimits'] = () => old.promise;
    const pending = refreshRateLimits();
    const next = deferred();
    impl['api.accountRateLimits'] = () => next.promise;
    const latest = refreshRateLimits();
    if (early) old.resolve(limits(99));
    next.resolve(limits(15));
    await latest;
    if (!early) old.resolve(limits(99));
    await pending;
    assert.deepEqual(getState().rateLimits, limits(15));
  }
});

test('a failed newer refresh does not discard a successful reading for the same account', async () => {
  const reading = deferred();
  impl['api.accountRateLimits'] = () => reading.promise;
  const pending = refreshRateLimits();
  impl['api.accountRateLimits'] = async () => {
    throw new Error('offline');
  };
  await refreshRateLimits();
  reading.resolve(limits(20));
  await pending;
  assert.deepEqual(getState().rateLimits, limits(20));
});

test('connect reads managed quotas before an unanswered account metadata read finishes', async () => {
  const account = deferred();
  const pool = { ...getState().accounts, active: 'managed', accounts: [{ id: 'managed' }] };
  impl['accounts.apply'] = async () => pool;
  impl['accounts.refreshUsage'] = async () => pool;
  impl['api.accountRead'] = () => account.promise;
  impl['api.accountRateLimits'] = async () => limits(20);
  const pending = connect();
  try {
    await flush();
    assert.equal(callsOf('accounts.refreshUsage').length, 1);
  } finally {
    account.resolve({ account: login('managed@example.com'), requiresOpenaiAuth: false });
    await pending;
  }
});

test('changing the active slot or losing the app-server retires its in-flight read', async () => {
  setState({ account: login('a@example.com'), rateLimits: limits(75) });
  const next = deferred();
  impl['api.accountRateLimits'] = () => next.promise;
  const pending = refreshRateLimits();
  setState({ accounts: { ...getState().accounts, active: 'next' } });
  next.resolve(limits(20));
  await pending;
  const disconnected = deferred();
  impl['api.accountRateLimits'] = () => disconnected.promise;
  const unfinished = refreshRateLimits();
  onCodexStatus({ kind: 'error', error: 'disconnected' });
  disconnected.resolve(limits(99));
  await unfinished;
  assert.deepEqual(getState().rateLimits, limits(75));
});
