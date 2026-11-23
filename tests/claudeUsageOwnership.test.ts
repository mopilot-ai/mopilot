// Whose Claude Code plan usage a row shows, and when it is read (#1582): every signed-in login is read whatever state
// the login in use is in, a sign-in reads at once, a reading belongs to the server account it measured, and a window
// whose reset passed since it was read is not shown as full. Renderer side; main is a stub.
import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset, tick } from './support/harness-logic-fakes.ts';
import { deferred } from './support/async-scenarios.ts';

// detection starts a minute timer for usage: held here, so the run can end
const realInterval = globalThis.setInterval;
globalThis.setInterval = (() => ({ unref() {} })) as any;
after(() => void (globalThis.setInterval = realInterval));
const claude = await import('../src/session/harness/claude.ts');
const usageMod = await import('../src/session/harness/claude/usage.ts');
const claudeAccountsMod = await import('../src/session/harness/claude/accounts.ts');
const { createUsageRefresher, mergeUsage, usageFetchState, usageOfLogin } = await import('../src/harness/claudeUsage.ts');
const { claudeAccounts, accountStatusText } = await import('../src/harness/accounts.ts');
const { usedNow, tightestWindow } = await import('../src/harness/usageWindows.ts');

const flush = async () => {
  for (let i = 0; i < 12; i++) await tick();
};
const USAGE = 'Current session: 10% used · resets 5pm\nCurrent week (all models): 40% used';
const A = 'acct-a';
const B = 'acct-b';

let reads: { id: string; reason: string }[];
let ended: string[][] = [];
function claudeNative(o: any = {}) {
  reads = [];
  fx.native.claude = {
    detect: async () => ({ state: 'ready', bin: '/bin/claude', candidates: [], auth: {}, plan: null }),
    probe: async () => ({ models: [], account: { email: 'me@x' }, fastBlocked: null }),
    refreshAccounts: async () => fx.state.claudeAccounts,
    signInEnded: async (ids: string[]) => void ended.push(ids),
    list: async () => [],
    usage: async (_bin: string, id: string, reason: string) => (reads.push({ id, reason }), { state: 'success', text: USAGE, account: A }),
    ...o,
  };
}
const logins = () => ({
  active: 'b',
  autoSwitch: true,
  login: null,
  accounts: [
    { id: 'default', email: 'a@x', loggedIn: true, authMethod: 'claude.ai', serverId: A },
    { id: 'b', email: 'b@x', loggedIn: true, authMethod: 'claude.ai', serverId: B },
  ],
});

beforeEach(() => {
  reset();
  claudeNative();
});

test('every signed-in login is read while the login in use is being checked or is signed out', async () => {
  fx.state.claudeAccounts = logins();
  for (const state of ['detecting', 'signin', 'error']) {
    fx.state.claude.status = { state, bin: '/bin/claude', usage: null };
    await claude.refreshClaudeUsage('now');
    await flush();
    assert.deepEqual(reads.map((r) => r.id).sort(), ['b', 'default'], `while the login in use is ${state}`);
    claudeNative();
  }
  // nothing to run, or a key bills every login: nothing is read
  for (const status of [
    { state: 'missing', bin: null },
    { state: 'detecting', bin: null },
    { state: 'apikey', bin: '/bin/claude' },
  ]) {
    fx.state.claude.status = { ...status, usage: null };
    await claude.refreshClaudeUsage('now');
    assert.deepEqual(reads, [], status.state);
  }
});

test('a Re-check after signing a login in again tells main the sign-in ended for it and the login in use', async () => {
  fx.state.claudeAccounts = logins();
  fx.state.route = { name: 'thread', id: 'x' };
  claudeNative({ reloginCommand: async () => ['/bin/claude', 'auth', 'login'] });
  await claude.reloginClaudeAccount('default');
  ended = [];
  await claude.recheckClaude();
  assert.deepEqual(ended, [['default', 'b']]);
});

test('a sign-in that ends reads usage at once, before the login check and the model probe finish', async () => {
  fx.state.claudeAccounts = logins();
  fx.state.claude.status = { state: 'signin', bin: '/bin/claude', usage: null };
  let detected!: () => void;
  claudeNative({
    // the re-check (a real model call) is still running
    detect: () => new Promise((r) => (detected = () => r({ state: 'ready', bin: '/bin/claude', candidates: [], auth: {}, plan: null }))),
  });
  ended = [];
  claude.endClaudeLoginTerm();
  await flush();
  assert.deepEqual(ended[0], ['b'], "main is told first: the login in use's backoff is gone before it is read");
  assert.deepEqual(
    reads
      .filter((r) => r.reason === 'now')
      .map((r) => r.id)
      .sort(),
    ['b', 'default'],
    'read without waiting for the re-check',
  );
  detected();
  await flush();
  // main could not be told: the sign-in is still read
  claudeNative({
    signInEnded: async () => {
      throw new Error('no main');
    },
  });
  claude.endClaudeLoginTerm();
  await flush();
  assert.ok(reads.some((r) => r.reason === 'now'));
});

test("a reading of another server account replaces the login's figures instead of merging into them", () => {
  const old = {
    windows: [
      { label: 'Weekly', usedPercent: 100, resetsAt: 9e9 },
      { label: 'Weekly Opus', usedPercent: 5, resetsAt: 9e9 },
    ],
    at: 2_000,
    account: A,
  };
  const fresh = { windows: [{ label: 'Weekly', usedPercent: 7, resetsAt: 9e9 }], at: 1_000, account: B };
  // older, and of another account: still the one shown, with none of the old account's windows
  assert.deepEqual(mergeUsage(old, fresh), { ...fresh, status: null, fetchState: 'success', fetchError: null });
  // a reading that names no account (from before readings named one) is replaced by one that does
  const { account: _a, ...unnamed } = old;
  assert.equal(mergeUsage(unnamed, fresh)?.windows.length, 1);
  // the same account merges as before: a newer reading keeps a window it lacks
  assert.equal(mergeUsage(old, { ...fresh, at: 3_000, account: A })?.windows.length, 2);
  // an older reading of the same account leaves the newer one
  assert.equal(mergeUsage(old, { ...fresh, account: A })?.windows[0].usedPercent, 100);
  // a failed read of another account drops the old account's figures; of the same account it keeps them
  assert.deepEqual(usageFetchState(old, 'unavailable', 'no figures', B).windows, []);
  assert.equal(usageFetchState({ ...old, status: 'rejected' }, 'error', 'x', B).status, null, "nor the old account's limit status");
  assert.equal(usageFetchState(old, 'unavailable', 'no figures', A).windows.length, 2);
  assert.equal(usageFetchState(old, 'error', 'x').windows.length, 2, 'an answer naming no account keeps what is known');
});

test("main's answer names the account it measured: a login signed in again as another account drops the old figures", async () => {
  fx.state.claudeAccounts = logins();
  fx.state.claude.status = { state: 'ready', bin: '/bin/claude', usage: null };
  fx.state.claudeUsage = {
    default: { windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: 9e9 }], at: Date.now() + 60_000, account: B },
  };
  claudeNative({
    usage: async () => ({ state: 'success', text: 'Current week (all models): 30% used', measuredAt: Date.now(), account: A }),
  });
  await claude.refreshClaudeUsage('now');
  await flush();
  assert.equal(fx.state.claudeUsage.default.account, A);
  assert.deepEqual(
    fx.state.claudeUsage.default.windows.map((w: any) => w.usedPercent),
    [30],
  );
  // an answer with no figures for another account leaves nothing of the old account's
  fx.state.claudeUsage = { default: { windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: 9e9 }], at: 1, account: B } };
  claudeNative({ usage: async () => ({ state: 'success', text: 'You are currently using your subscription', account: A }) });
  await claude.refreshClaudeUsage('now');
  await flush();
  assert.equal(fx.state.claudeUsage.default.fetchState, 'unavailable');
  assert.deepEqual(fx.state.claudeUsage.default.windows, []);
});

test("a turn's live figures are noted as the account its login is now", () => {
  fx.state.claudeAccounts = logins();
  usageMod.noteLiveUsage('b', { windows: [{ label: '5h', usedPercent: 3, resetsAt: 9e9 }], at: 5 });
  assert.equal(fx.state.claudeUsage.b.account, B);
  // a login whose account is not known yet notes none
  fx.state.claudeAccounts = { ...logins(), accounts: [{ id: 'b', email: 'b@x', loggedIn: true, serverId: null }] };
  fx.state.claudeUsage = {};
  usageMod.noteLiveUsage('b', { windows: [{ label: '5h', usedPercent: 3, resetsAt: 9e9 }], at: 5 });
  assert.equal(fx.state.claudeUsage.b.account, null);
});

test("a turn's live figures are the account its process started as, when main knew it (#1582)", () => {
  fx.state.claudeAccounts = logins();
  fx.state.claudeUsage = {};
  // the process started as A; the login has been signed in again as B since
  usageMod.noteLiveUsage('b', { windows: [{ label: '5h', usedPercent: 3, resetsAt: 9e9 }], at: 5 }, A);
  assert.equal(fx.state.claudeUsage.b.account, A);
  assert.deepEqual(usageOfLogin(fx.state.claudeUsage.b, { serverId: B })?.windows, [], "so the row of B never shows A's figures");
});

test("a row never shows another account's figures: not its own reading, nor the status of the login in use", () => {
  const theirs = { windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: 9e9 }], at: Date.now(), account: B };
  const mine = { ...theirs, account: A };
  const row = { id: 'default', serverId: A };
  assert.deepEqual(usageOfLogin(theirs, row)?.windows, [], "another account's figures are dropped");
  // how its last read went still shows: the row says why there are no figures
  assert.equal(usageOfLogin({ ...theirs, fetchState: 'unavailable' }, row)?.fetchState, 'unavailable');
  assert.equal(usageOfLogin(mine, row), mine);
  assert.equal(usageOfLogin(mine, { serverId: null }), mine, 'an account not known yet: the reading stands');
  assert.deepEqual(
    usageOfLogin({ ...mine, account: undefined }, row)?.windows,
    [],
    'a reading naming no account is not shown for a known one',
  );
  assert.equal(usageOfLogin(null, row), null);
  const st = { state: 'ready', bin: '/x', version: null, plan: 'Claude Max', email: 'a@x', usage: theirs } as any;
  const pool = { ...logins(), active: 'default' };
  const r = claudeAccounts(st, pool as any, { default: theirs, b: mine } as any);
  assert.equal(r.accounts[0].usage.source, 'none', 'the login in use falls back to nothing, not to the status');
  assert.equal(r.accounts[0].left, null);
  assert.equal(r.accounts[1].usage.source, 'none', 'b is account B, and this reading is A');
});

test('a window whose reset passed since it was read is not known, never shown as full', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
  try {
    const now = 1_000_000_000;
    const past = { label: 'Weekly', usedPercent: 100, resetsAt: now - 60 };
    const ahead = { label: '5h', usedPercent: 40, resetsAt: now + 3600 };
    assert.equal(usedNow(past), null);
    assert.equal(usedNow(ahead), 40);
    assert.equal(usedNow({ usedPercent: 12, resetsAt: null }), 12, 'a window with no known reset still counts');
    assert.equal(tightestWindow([past, ahead]), ahead, 'a window not known is never the tightest');
    // the row: what is left is the windows still known; with none, it says the figures are out of date
    const st = { state: 'ready', bin: '/x', version: null, plan: null, email: 'a@x', usage: null } as any;
    const pool = { active: 'default', autoSwitch: true, login: null, accounts: [{ id: 'default', email: 'a@x', loggedIn: true }] };
    const at = Date.now() - 44 * 3600_000;
    const both = claudeAccounts(st, pool as any, { default: { windows: [past, ahead], at } } as any).accounts[0];
    assert.equal(both.left, 60);
    const gone = claudeAccounts(st, pool as any, { default: { windows: [past], at } } as any).accounts[0];
    assert.equal(gone.left, null);
    assert.equal(accountStatusText(gone).text, 'Reset since last read · updated 2640m ago');
  } finally {
    mock.timers.reset();
  }
});

test("a reading that does not know its account keeps the account the login's figures already name", () => {
  const prev = { windows: [{ label: 'Weekly', usedPercent: 10, resetsAt: 9e9 }], at: 1, account: A };
  assert.equal(mergeUsage(prev, { windows: [{ label: '5h', usedPercent: 3, resetsAt: 9e9 }], at: 2, account: null })?.account, A);
  assert.equal(mergeUsage(null, { windows: [{ label: '5h', usedPercent: 3, resetsAt: 9e9 }], at: 2 })?.account, undefined);
});

test("the harness status and the limit offer never take another account's figures either", async () => {
  const { limitInstances } = await import('../src/session/harness/billing.ts');
  const theirs = { windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: 9e9 }], at: 1, account: A };
  fx.state.claudeAccounts = logins();
  // b is account B; a limit read under b while it was account A is not b's
  fx.state.claudeUsage = { b: theirs };
  const { from } = limitInstances('claude', fx.state, null, false);
  assert.equal(from?.limited, false);
  fx.state.claudeUsage = { b: { ...theirs, account: B } };
  assert.equal(limitInstances('claude', fx.state, null, false).from?.limited, true);
  // switching to b: the status shows b's figures only when they are b's account's
  fx.state.claude.status = { state: 'ready', bin: '/bin/claude', usage: null };
  fx.state.claudeAccounts = { ...logins(), active: 'default' };
  fx.state.claudeUsage = { b: theirs };
  claudeAccountsMod.setAccounts(logins() as any);
  assert.deepEqual(fx.state.claude.status.usage?.windows, []);
  // a reading noted for the login in use: the status takes it only while it is that login's account
  usageMod.noteUsage('b', { windows: [{ label: '5h', usedPercent: 1, resetsAt: 9e9 }], at: 9, account: A });
  assert.deepEqual(fx.state.claude.status.usage?.windows, []);
  usageMod.noteUsage('b', { windows: [{ label: '5h', usedPercent: 2, resetsAt: 9e9 }], at: 10, account: B });
  assert.equal(fx.state.claude.status.usage.windows[0].usedPercent, 2);
  // detection: the status's usage is the active login's own, else what it had
  fx.state.claudeUsage = { b: theirs };
  await claude.detectClaude(true);
  await flush();
  assert.deepEqual(fx.state.claude.status.usage?.windows ?? [], [], "none of A's figures reach the status of b");
});

test('a row whose reading is another account\'s says how its own last read went, not "not loaded"', () => {
  const st = { state: 'ready', bin: '/x', version: null, plan: null, email: 'b@x', usage: null } as any;
  const theirs = { windows: [{ label: 'Weekly', usedPercent: 54, resetsAt: 9e9 }], at: 1, fetchState: 'unavailable', fetchError: 'x' };
  const row = claudeAccounts(st, logins() as any, { b: theirs } as any).accounts[1];
  assert.equal(row.left, null);
  assert.equal(accountStatusText(row).text, 'Usage unavailable');
});

test('the refresher names the account on every note: readings, failures and live figures (#1582)', async () => {
  const notes: any[] = [];
  const make = (result: any, current: any = null) =>
    createUsageRefresher({
      read: async () => result,
      current: () => current,
      noteReading: (_id, r) => notes.push(['reading', r]),
      noteFetch: (...a) => notes.push(['fetch', ...a]),
    });
  const live = { windows: [{ label: '5h', usedPercent: 5, resetsAt: 9e9 }], at: 9e12 };
  // live figures from main take the account the answer names; an answer from an older main names none
  await make({ state: 'error', error: 'x', account: B, live })('b');
  assert.equal(notes.find((n) => n[0] === 'reading')[1].account, B);
  notes.length = 0;
  await make({ state: 'error', error: 'x', live })('b');
  assert.equal('account' in notes.find((n) => n[0] === 'reading')[1], false);
  // the same failure again is not noted, unless it is now another account's
  const failed: any = {
    windows: [{ label: 'Weekly', usedPercent: 9, resetsAt: 9e9 }],
    at: 1,
    account: A,
    fetchState: 'error',
    fetchError: 'x',
  };
  notes.length = 0;
  await make({ state: 'error', error: 'x', account: A }, failed)('b');
  assert.deepEqual(notes, []);
  await make({ state: 'error', error: 'x', account: B }, failed)('b');
  assert.deepEqual(notes, [['fetch', 'b', 'error', 'x', B]]);
  // the same figures of another account are noted again, as that account's
  notes.length = 0;
  const parsed = { ...failed, fetchState: 'success', windows: [], at: 5 };
  await make({ state: 'success', text: 'Current week (all models): 9% used', measuredAt: 5, account: B }, parsed)('b');
  assert.equal((notes[0] as any)[1].account, B);
  // another account's reading keeps its own status line
  assert.equal(
    mergeUsage(failed, { windows: [{ label: '5h', usedPercent: 1, resetsAt: 9e9 }], at: 0, status: 'allowed', account: B })?.status,
    'allowed',
  );
});

test('sign-in invalidates both a pending now and the request started while main was being told', async () => {
  const pool = logins();
  pool.accounts = pool.accounts.filter((a) => a.id === 'b');
  fx.state.claudeAccounts = pool;
  fx.state.claude.status = { state: 'ready', bin: '/bin/claude', usage: null };
  const told = deferred<void>();
  const detection = deferred<any>();
  const requests = [deferred<any>(), deferred<any>(), deferred<any>()];
  let count = 0;
  const answer = (percent: number) => ({ state: 'success', text: `Current week: ${percent}% used`, measuredAt: Date.now(), account: B });
  claudeNative({
    signInEnded: () => told.promise,
    detect: () => detection.promise,
    usage: () => requests[count++]?.promise ?? Promise.resolve(answer(7)),
  });
  const old = claude.refreshClaudeUsage('now');
  await flush();
  claude.endClaudeLoginTerm();
  const gap = claude.refreshClaudeUsage('now');
  await flush();
  assert.equal(count, 2);
  requests[0].resolve(answer(99));
  await old;
  assert.equal(fx.state.claudeUsage.b.windows.length, 0, 'retired figures never publish');
  told.resolve();
  await flush();
  assert.equal(count, 3, 'post-sign-in now reaches main despite the gap request');
  requests[1].resolve(answer(88));
  await gap;
  requests[2].resolve(answer(7));
  await flush();
  assert.equal(fx.state.claudeUsage.b.windows[0].usedPercent, 7);
  detection.resolve({ state: 'ready', bin: '/bin/claude', candidates: [], auth: {}, plan: null });
  await flush();
});

test('the signedIn event retires the added login pending now before requesting its own figures', async () => {
  const pool = logins();
  pool.accounts = pool.accounts.filter((a) => a.id === 'b');
  fx.state.claudeAccounts = pool;
  fx.state.claude.status = { state: 'ready', bin: '/bin/claude', usage: null };
  const pending = deferred<any>();
  let count = 0;
  claudeNative({
    usage: () => (++count === 1 ? pending.promise : Promise.resolve({ state: 'success', text: 'Current week: 7% used', account: B })),
  });
  const old = claude.refreshClaudeUsage('now');
  await flush();
  claudeAccountsMod.onAccountsEvent({ type: 'notice', kind: 'signedIn', id: 'b', email: 'b@x' });
  await flush();
  assert.equal(count, 2);
  pending.resolve({ state: 'error', error: 'old login failed' });
  await old;
  assert.equal(fx.state.claudeUsage.b.fetchState, 'success');
  assert.equal(fx.state.claudeUsage.b.windows[0].usedPercent, 7);
});
