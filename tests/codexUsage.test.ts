import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { codexAccounts, codexLimitSnapshot, accountStatusText } = await import('../src/harness/accounts.ts');
const { refreshCodexUsage } = await import('../src/harness/refreshCodexUsage.ts');
const req = createRequire(import.meta.url);
const { Accounts, limitInfo } = req('../electron/identity/codexAccounts.cjs');
const { UsageRefresh, BACKOFF_BASE_MS } = req('../electron/identity/contract/usageRefresh.cjs');

const snapshot = (used = 97, extra: any = {}) => ({
  limitId: 'codex',
  primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 4e9 },
  secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 4e9 },
  ...extra,
});
const account = (id: string, used: number | null = 97, extra: any = {}) => ({
  id,
  kind: 'chatgpt',
  email: `${id}@example.test`,
  planType: 'team',
  status: 'ok',
  limits: used == null ? null : limitInfo(snapshot(used)),
  ...extra,
});
function manager(rows = [account('a')]) {
  const a = Object.create(Accounts.prototype);
  a.state = { active: rows[0].id, accounts: rows };
  a.applied = rows[0].id;
  a.syncDefault = () => {};
  a.changed = () => {};
  a.changedSoon = () => {};
  a.view = () => a.state;
  a.clock = { t: Date.now() };
  a.usageRefresh = new UsageRefresh({ now: () => a.clock.t });
  return a;
}

test('95% and 3% remain attached to their accounts through notifications and switches', () => {
  const rows = [account('a', 5), account('b', 97), account('unknown', null)];
  for (const relay of [true, false])
    for (const active of ['a', 'b', 'unknown', null, 'removed'])
      for (const used of [5, 97]) {
        const view = codexAccounts({
          accounts: { accounts: rows, active, relay } as any,
          account: null,
          rateLimits: { rateLimits: snapshot(used) },
        });
        assert.deepEqual(
          view.accounts.map((a) => a.left),
          [95, 3, null],
        );
        assert.equal(view.active?.left ?? null, active === 'a' || active == null ? 95 : active === 'b' ? 3 : null);
        assert.equal(accountStatusText(view.accounts[2]).text, 'Usage unknown');
      }
});

test('a lone login uses only the Codex quota and treats empty snapshots as unknown', () => {
  const other = snapshot(100, { limitId: 'other' });
  for (const [limits, expected] of [
    [null, null],
    [{}, null],
    [{ rateLimits: {} }, null],
    [{ rateLimits: snapshot(97) }, 3],
    [{ rateLimits: { secondary: { usedPercent: 70 } } }, 30],
    [{ rateLimitsByLimitId: { other, codex: snapshot(5) } }, 95],
    [{ rateLimitsByLimitId: { other } }, null],
    [{ rateLimits: other }, null],
    [{ rateLimits: { primary: {} } }, 100],
  ] as const) {
    const view = codexAccounts({ accounts: { accounts: [], active: null } as any, account: { type: 'chatgpt' }, rateLimits: limits });
    assert.equal(view.active?.left, expected);
  }
  assert.equal(codexLimitSnapshot({ rateLimits: snapshot(5, { limitId: undefined }) })?.primary.usedPercent, 5);
});

test('managed metadata preserves keys, credits, limits, missing usage and reset expiry', () => {
  const rows = [
    account('key', 5, { kind: 'apiKey' }),
    account('credits', null, { kind: 'apiKey', mopilot: true }),
    account('full', 100),
    account('expired-limit', 100, { limits: { used: 100, reached: true, resetsAt: 1, at: 42 } }),
    account('no-reset', 100, { limits: { used: 100, reached: true, resetsAt: null, at: 42 } }),
    account('no-plan', null, { planType: null }),
    account('empty', null, { limits: {} }),
  ];
  const view = codexAccounts({ accounts: { accounts: rows, active: 'key' } as any, account: null, rateLimits: null, balanceMicros: 1 });
  assert.equal(view.accounts[0].left, null);
  assert.equal(view.accounts[1].usage.balanceMicros, 1);
  assert.ok(view.accounts[2].limited);
  assert.equal(view.accounts[3].limited, null);
  assert.ok(view.accounts[4].limited);
  assert.equal(view.accounts[5].plan, null);
  assert.equal(view.accounts[6].left, null);
});

test('a Codex account read long ago (an idle one is read hourly) says how old its figures are; a fresh one does not', () => {
  const row = (id: string, at: number) => ({
    id,
    kind: 'chatgpt',
    email: `${id}@example.test`,
    planType: 'plus',
    status: 'ok',
    limits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null }, secondary: null, used: 40, reached: false, at },
  });
  const now = Date.now();
  const view = codexAccounts({
    accounts: { accounts: [row('idle', now - 45 * 60_000), row('cur', now)], active: 'cur' } as any,
    account: null,
    rateLimits: null,
  });
  assert.deepEqual(accountStatusText(view.accounts[0]), { text: '60% left · updated 45m ago', tone: 'muted' });
  assert.deepEqual(accountStatusText(view.accounts[1]), { text: '60% left', tone: 'ok' });
});

test('usage reads use each account sidecar, including the applied active account', async () => {
  const rows = [account('a'), account('b', 5)];
  const a = manager(rows),
    calls: any[] = [];
  a.mainRequest = () => {
    throw new Error('unscoped main read');
  };
  a.sidecar = (row: any) => ({
    call: async (method: string, params: any) => {
      calls.push([row.id, method, params]);
      return { rateLimits: snapshot(row.id === 'a' ? 97 : 5) };
    },
  });
  await a.refreshUsage(undefined, 'now');
  assert.deepEqual(calls, [
    ['a', 'account/rateLimits/read', {}],
    ['b', 'account/rateLimits/read', {}],
  ]);
  assert.deepEqual(
    rows.map((r) => r.limits.used),
    [97, 5],
  );
});

test('sidecar authentication errors refresh once while other errors propagate', async () => {
  for (const error of ['401 unauthorized', 'token expired', 'network unavailable']) {
    const a = manager(),
      row = a.state.accounts[0];
    let calls = 0,
      refreshes = 0;
    a.sidecar = () => ({
      call: async () => {
        if (++calls === 1) throw new Error(error);
        return { rateLimits: snapshot(5) };
      },
    });
    a.refresh = async (value: any) => {
      assert.equal(value, row);
      refreshes++;
    };
    if (error === 'network unavailable') await assert.rejects(a.readUsage(row), /network unavailable/);
    else assert.equal((await a.readUsage(row)).rateLimits.primary.usedPercent, 5);
    assert.equal(refreshes, error === 'network unavailable' ? 0 : 1);
  }
});

test('a slow poll cannot overwrite newer per-account headers', async () => {
  const a = manager(),
    row = a.state.accounts[0];
  let finish!: (r: any) => void;
  a.readUsage = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = a.refreshUsage(undefined, 'now');
  await Promise.resolve();
  a.noteUsageHeaders(row, { 'x-codex-primary-used-percent': '98' });
  const fresh = row.limits;
  finish({ rateLimits: snapshot(5) });
  await pending;
  assert.equal(row.limits, fresh);
  assert.equal(row.limits.used, 98);
});

test('overlapping polls of one account (a menu, Settings, the timer) share one sidecar read', async () => {
  const a = manager([account('a'), account('b', 5)]);
  const calls: string[] = [];
  let finish!: () => void;
  a.readUsage = (row: any) => {
    calls.push(row.id);
    return row.id === 'a' ? new Promise((resolve) => (finish = () => resolve({ rateLimits: snapshot(99) }))) : Promise.resolve(null);
  };
  const first = a.refreshUsage(['a'], 'now');
  await Promise.resolve();
  await Promise.resolve();
  const second = a.refreshUsage(undefined, 'now');
  await Promise.resolve();
  await Promise.resolve();
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(a.state.accounts[0].limits.used, 99);
});

test('missing, empty and unrelated usage readings preserve the last known quota', async () => {
  for (const reply of [
    null,
    {},
    { rateLimits: {} },
    { rateLimits: snapshot(5, { limitId: 'other' }) },
    { rateLimitsByLimitId: { other: snapshot(5, { limitId: 'other' }) } },
  ]) {
    const a = manager(),
      row = a.state.accounts[0],
      previous = row.limits;
    a.readUsage = async () => reply;
    await a.refreshUsage(undefined, 'now');
    assert.equal(row.limits, previous);
  }
});

test('polls accept primary, secondary and backend-reached snapshots, preferring Codex', async () => {
  for (const snap of [
    snapshot(),
    snapshot(5, { limitId: undefined }),
    snapshot(5, { primary: null }),
    { rateLimitReachedType: 'primary' },
  ]) {
    const a = manager();
    a.readUsage = async () => ({ rateLimits: snapshot(5), rateLimitsByLimitId: { codex: snap } });
    await a.refreshUsage(undefined, 'now');
    assert.equal(a.state.accounts[0].limits.used, snap.primary?.usedPercent ?? snap.secondary?.usedPercent ?? null);
  }
});

test('failed polls keep quota and expiry status, back that account off, and a retry after the backoff succeeds', async () => {
  for (const [status, error] of [
    ['ok', new Error('unavailable')],
    ['expired', new Error('expired')],
    ['signin', 'unavailable'],
  ]) {
    const row = account('a', 97, { status }),
      a = manager([row]),
      previous = row.limits;
    a.readUsage = async () => {
      throw error;
    };
    await a.refreshUsage(undefined, 'now');
    assert.equal(row.limits, previous);
    assert.equal(row.status, status);
    assert.equal(row.error, status === 'expired' ? undefined : 'unavailable');
    let reads = 0;
    a.readUsage = async () => (reads++, { rateLimits: snapshot(5) });
    // backing off: even a Refresh click waits, and the view is not re-sent for nothing
    let changes = 0;
    a.changed = () => changes++;
    await a.refreshUsage(undefined, 'now');
    assert.equal(reads, 0);
    assert.equal(changes, 0);
    a.clock.t += BACKOFF_BASE_MS;
    await a.refreshUsage(undefined, 'now');
    assert.equal(reads, 1);
    assert.equal(changes, 1);
    assert.equal(row.status, status === 'expired' ? 'expired' : 'ok');
  }
});

test('poll account IDs and freshness filter exclude API keys and fresh accounts', async () => {
  const rows = [
    account('a'),
    account('b'),
    account('key', null, { kind: 'apiKey' }),
    account('legacy', 5, { kind: undefined, limits: null }),
  ];
  const a = manager(rows),
    calls: string[] = [];
  a.readUsage = async (row: any) => {
    calls.push(row.id);
    return { rateLimits: snapshot(5) };
  };
  await a.refreshUsage(['legacy', 'key'], 60_000);
  assert.deepEqual(calls, ['legacy']);
  calls.length = 0;
  await a.refreshUsage(undefined, 60_000);
  assert.deepEqual(calls, []);
});

test('the timer reads the account in use or one a chat used lately every 5 min, an idle account hourly', async () => {
  const rows = [account('a'), account('b'), account('c')];
  const a = manager(rows),
    calls: string[] = [];
  a.readUsage = async (row: any) => (calls.push(row.id), { rateLimits: snapshot(5) });
  const min = 60_000;
  // every reading is as old as when it was measured (limitInfo stamps Date.now()), so step the policy's clock
  a.usageRefresh.used('b');
  a.clock.t += 5 * min;
  await a.refreshUsage();
  assert.deepEqual(calls, ['a', 'b']);
  calls.length = 0;
  a.clock.t += 56 * min;
  await a.refreshUsage();
  assert.deepEqual(calls, ['a', 'c'], 'b was used over 30 min ago: idle again, read 5 min ago');
  // a surface opening reads an idle account after 15 min
  calls.length = 0;
  a.clock.t += 15 * min;
  await a.refreshUsage(undefined, 'surface');
  assert.deepEqual(calls, ['a', 'b', 'c']);
});

test('refresh keeps account reads independent of main-read failures and tolerates unavailable usage', async () => {
  for (const managed of [true, false])
    for (const mainFails of [true, false])
      for (const accountFails of [true, false]) {
        const calls: any[] = [];
        await refreshCodexUsage({
          readRateLimits: async () => {
            calls.push('main');
            if (mainFails) throw new Error('unavailable');
            return 42;
          },
          setRateLimits: (value) => {
            calls.push(['set', value]);
          },
          hasManagedAccounts: () => managed,
          refreshAccounts: async () => {
            calls.push('accounts');
            if (accountFails) throw new Error('unavailable');
          },
        });
        assert.deepEqual(calls, ['main', ...(mainFails ? [] : [['set', 42]]), ...(managed ? ['accounts'] : [])]);
      }
});
