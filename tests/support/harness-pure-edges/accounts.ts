// Account labels, login presentation and pool edge cases across harnesses.
import { test, assert } from './fixture.ts';

export function registerAccounts(accounts: typeof import('../../../src/harness/accounts.ts')) {
  test('accounts: plan names, the Codex pool and its single login', () => {
    assert.equal(accounts.planName('business_plus'), 'Business Plus');
    assert.equal(accounts.planName('self_serve_business'), 'Business');
    assert.equal(accounts.planName('mystery'), 'mystery');
    const future = Date.now() / 1000 + 3600;
    const pool = (accs: any[], active: any = null, rateLimits: any = null, extra: any = {}) =>
      accounts.codexAccounts({ accounts: { active, accounts: accs } as any, account: null, rateLimits, ...extra });
    let v = pool(
      [
        { id: 'a', kind: 'chatgpt', status: 'ok', limits: { used: 30, at: 0, reached: true, resetsAt: future } },
        { id: 'b', kind: 'chatgpt', status: 'ok', planType: 'pro', limits: { reached: true, resetsAt: null } },
      ],
      null,
      { rateLimitsByLimitId: { x: { primary: { usedPercent: 70 } } } },
    );
    assert.deepEqual(
      [v.active!.id, v.active!.left, v.active!.usage.source, v.active!.limited!.resetsAt, v.active!.plan],
      ['a', 70, 'polled', future, null],
      'a managed account reads its own polled usage, not the app-server cache',
    );
    assert.deepEqual(
      [v.accounts[1].plan, v.accounts[1].limited, v.accounts[1].usage.source, v.accounts[1].usage.at],
      ['Pro', { resetsAt: null }, 'none', null],
    );
    v = pool([{ id: 'a', kind: 'chatgpt', status: 'ok', limits: { used: 10, at: 5 } }], 'gone', {
      rateLimits: { secondary: { usedPercent: 20 } },
    });
    assert.equal(v.active, null);
    assert.equal(v.accounts[0].usage.at, 5);
    v = pool([{ id: 'm', kind: 'apiKey', mopilot: true, status: 'ok' }], 'm', {}, { balanceMicros: undefined });
    assert.equal(v.active!.usage.balanceMicros, null);
    v = pool([{ id: 'k', kind: 'apiKey', status: 'ok' }], 'k', { rateLimits: {} });
    assert.deepEqual([v.active!.left, v.active!.usage.source], [null, 'none']);
    assert.deepEqual(
      accounts.codexAccounts({ accounts: { active: null, accounts: [] } as any, account: null, rateLimits: null }).accounts,
      [],
    );
    const one = (account: any, rateLimits: any = null, requiresAuth = false) =>
      accounts.codexAccounts({ accounts: { active: null, accounts: [] } as any, account, rateLimits, requiresAuth }).active!;
    assert.deepEqual([one({ type: 'apiKey' }).plan, one({ type: 'apiKey' }).left, one({ type: 'apiKey' }).email], ['API key', null, null]);
    assert.deepEqual([one({ type: 'chatgpt' }, null, true).status, one({ type: 'chatgpt' }).plan], ['signin', null]);
    assert.deepEqual(
      [one({ type: 'chatgpt', planType: 'plus', email: 'a@x' }, { rateLimits: { primary: { usedPercent: 25 } } }).left],
      [75],
    );
  });

  test('accounts: Claude logins with and without the account list', () => {
    const future = Date.now() / 1000 + 3600;
    const st = (o: any = {}) => ({ state: 'ready', bin: '/c', version: '1', plan: null, email: null, usage: null, ...o });
    const pool = {
      active: 'a',
      accounts: [
        { id: 'a', loggedIn: true },
        { id: 'b', loggedIn: false, email: 'b@x', subscriptionType: 'pro' },
        { id: 'c', loggedIn: true, authMethod: 'console', email: 'c@x' },
        { id: 'gone', loggedIn: false },
      ],
    };
    const usage = { b: { windows: [{ label: '5h', usedPercent: 100, resetsAt: null }], at: 0, fetchState: 'error', fetchError: 'x' } };
    let v = accounts.claudeAccounts(
      st({ email: 'a@x', plan: 'Max', usage: { windows: [{ label: '5h', usedPercent: 100, resetsAt: future }], at: 1 } }) as any,
      pool as any,
      usage as any,
    );
    assert.deepEqual(
      v.accounts.map((a) => [a.id, a.email, a.plan, a.kind, a.status, a.left]),
      [
        ['a', 'a@x', 'Max', 'subscription', 'ok', 0],
        ['b', 'b@x', 'Claude Pro', 'subscription', 'signin', 0],
        ['c', 'c@x', null, 'apiKey', 'ok', null],
      ],
    );
    assert.deepEqual(v.accounts[0].limited, { resetsAt: future });
    assert.deepEqual([v.accounts[1].limited, v.accounts[1].usage.fetchState, v.accounts[1].usage.at], [{ resetsAt: null }, 'error', null]);
    v = accounts.claudeAccounts(st({ state: 'apikey' }) as any, pool as any);
    assert.deepEqual(
      v.accounts.map((a) => [a.plan, a.kind, a.left, a.limited]),
      [
        ['API key', 'apiKey', null, null],
        ['API key', 'apiKey', null, null],
        ['API key', 'apiKey', null, null],
      ],
    );
    // detecting with nobody signed in: nothing known yet; with someone signed in it shows
    assert.deepEqual(
      accounts.claudeAccounts(st({ state: 'detecting' }) as any, { active: 'z', accounts: [{ id: 'y', loggedIn: false }] } as any).accounts,
      [],
    );
    v = accounts.claudeAccounts(st({ state: 'detecting' }) as any, { active: 'z', accounts: [{ id: 'y', loggedIn: true }] } as any);
    assert.deepEqual([v.active, v.accounts.length], [null, 1]);
    assert.equal(accounts.claudeAccounts(st({ state: 'signin' }) as any, pool as any).accounts[0].status, 'signin');
    // before the list arrives: the CLI's own login
    assert.equal(accounts.claudeAccounts(st({ state: 'error' }) as any).active, null);
    assert.equal(accounts.claudeAccounts(st({ state: 'signin' }) as any, { active: 'x', accounts: [] } as any).active, null);
    assert.equal(accounts.claudeAccounts(st({ state: 'signin', email: 'a@x' }) as any).active!.status, 'signin');
    assert.equal(accounts.claudeAccounts(st({ state: 'signin', plan: 'Pro' }) as any).active!.email, null);
    v = accounts.claudeAccounts(st({ state: 'apikey', usage: { windows: [], at: 0 } }) as any);
    assert.deepEqual([v.active!.kind, v.active!.left, v.active!.limited, v.active!.usage.source], ['apiKey', null, null, 'none']);
    v = accounts.claudeAccounts(st({ usage: { windows: [], at: 3 } }) as any);
    assert.deepEqual([v.active!.left, v.active!.usage.source, v.active!.usage.at], [null, 'none', 3]);
  });

  test('accounts: names, summaries and status lines', () => {
    const a = (o: any = {}) => ({
      id: 'a',
      harness: 'codex',
      email: null,
      plan: null,
      kind: 'subscription',
      status: 'ok',
      usage: { windows: [], source: 'none', at: null },
      left: null,
      limited: null,
      ...o,
    });
    assert.equal(accounts.accountName(a({ email: 'x@y' }) as any), 'x@y');
    assert.equal(accounts.accountName(a({ plan: accounts.MOPILOT_PLAN }) as any), accounts.MOPILOT_PLAN);
    assert.equal(accounts.accountName(a({ kind: 'apiKey' }) as any), 'API key');
    assert.equal(accounts.accountName(a() as any), 'Signed-in account');
    const now = Date.now() / 1000;
    assert.equal(accounts.until(now + 2 * 86400 + 3 * 3600 + 30), '2d 3h');
    assert.equal(accounts.until(now + 3 * 3600 + 5 * 60 + 30), '3h 5m');
    assert.equal(accounts.until(now + 5 * 60 + 30), '5m');
    assert.equal(accounts.until(now - 100), '0m');
    assert.equal(accounts.needsAttention(a() as any), false);
    assert.equal(accounts.needsAttention(a({ status: 'expired' }) as any), true);
    const text = (o: any) => accounts.accountStatusText(a(o) as any).text;
    assert.equal(text({ status: 'expired' }), 'Sign-in expired');
    assert.equal(text({ status: 'signin' }), 'Signed out');
    assert.equal(text({ plan: accounts.MOPILOT_PLAN }), 'Balance unknown');
    assert.match(text({ plan: accounts.MOPILOT_PLAN, usage: { windows: [], balanceMicros: 5_000_000 } }), /left$/);
    assert.equal(text({ kind: 'apiKey' }), 'Billed per token');
    assert.equal(text({ limited: { resetsAt: null } }), 'Limit reached');
    assert.match(text({ limited: { resetsAt: now + 7200 } }), /^Limit reached · resets in/);
    assert.equal(text({ left: 40 }), '40% left');
    assert.equal(text({ harness: 'claude', left: 40, usage: { windows: [], fetchState: 'error', at: null } }), '40% left');
    assert.equal(
      text({ harness: 'claude', left: 40, usage: { windows: [], fetchState: 'unavailable', at: Date.now() - 120_000 } }),
      '40% left · updated 2m ago',
    );
    assert.equal(text({ harness: 'claude', left: 40, usage: { windows: [], at: Date.now() - 20 * 60_000 } }), '40% left · updated 20m ago');
    assert.equal(text({ harness: 'claude', left: 40, usage: { windows: [], at: Date.now() } }), '40% left');
    assert.equal(text({ harness: 'claude', usage: { windows: [], fetchState: 'loading' } }), 'Fetching usage…');
    assert.equal(text({ harness: 'claude', usage: { windows: [], fetchState: 'error' } }), 'Usage refresh failed');
    assert.equal(text({ harness: 'claude', usage: { windows: [], fetchState: 'unavailable' } }), 'Usage unavailable');
    assert.equal(text({ harness: 'claude', usage: { windows: [] } }), 'Usage not loaded');
    assert.equal(text({}), 'Usage unknown');
  });
}
