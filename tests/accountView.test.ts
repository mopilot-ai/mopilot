// The one account view every account surface reads (src/harness/accountView.ts): each account's state, status,
// short form, meters and action, a harness's phase and what it says with no account, ACP and MoPilot credits.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { harnessPhase, phaseLabelOf, harnessAccountView, servingRow, standInRow, basicAccountView, creditsView, IDLE_HINT } = await import(
  '../src/harness/accountView.ts'
);
const { MOPILOT_PLAN } = await import('../src/harness/accounts.ts');

const win = (label: string, usedPercent: number) => ({ label, usedPercent, resetsAt: null });
const acct = (p: any = {}) => ({
  id: 'a',
  harness: 'codex',
  email: 'a@x.com',
  plan: 'Pro',
  kind: 'subscription',
  status: 'ok',
  left: 70,
  limited: null,
  usage: { windows: [win('5h', 30), win('Weekly', 10)], source: 'polled', at: null },
  ...p,
});
const ready = { state: 'ready', bin: '/x', version: null, plan: null, usage: null } as any;
const viewOf = (accounts: any[], active: any = accounts[0] ?? null, harness = 'codex') =>
  ({ harness, active, accounts, multi: true }) as any;

test('a harness phase from its status: idle is "not started", never "checking"', () => {
  assert.equal(harnessPhase({ state: 'detecting', idle: true }), 'not-started');
  assert.equal(harnessPhase({ state: 'detecting' }), 'checking');
  assert.equal(harnessPhase({ state: 'signin' }), 'signed-out');
  assert.equal(harnessPhase({ state: 'missing' }), 'missing');
  assert.equal(harnessPhase({ state: 'error' }), 'error');
  assert.equal(harnessPhase({ state: 'ready' }), 'ready');
  assert.equal(harnessPhase({ state: 'apikey' }), 'ready');
  assert.deepEqual(phaseLabelOf({ state: 'apikey' }), { text: 'API key', tone: '' });
  assert.deepEqual(phaseLabelOf({ state: 'ready' }), { text: 'Ready', tone: 'ok' });
  assert.deepEqual(phaseLabelOf({ state: 'detecting', idle: true }), { text: 'Starts on first use', tone: '' });
  assert.deepEqual(phaseLabelOf({ state: 'signin' }), { text: 'Signed out', tone: 'warn' });
  assert.deepEqual(phaseLabelOf({ state: 'missing' }), { text: 'Not installed', tone: 'err' });
});

test('each account state reads one way: status, short form, meters and the main action', () => {
  const rows = harnessAccountView(
    ready,
    viewOf([
      acct(),
      acct({ id: 'b', email: 'b@x.com', left: null, usage: { windows: [], source: 'none', at: null } }),
      acct({ id: 'c', email: 'c@x.com', status: 'expired' }),
      // a login whose config folder moved (electron/identity/contract/accountDirs.cjs): signed out, with the reason under it
      acct({ id: 'mv', harness: 'claude', email: 'mv@x.com', status: 'signin', reconfirm: true }),
      acct({ id: 'd', email: 'd@x.com', left: 0, limited: { resetsAt: null } }),
      acct({ id: 'e', email: null, kind: 'apiKey', plan: 'API key', left: null, usage: { windows: [], source: 'none', at: null } }),
      acct({
        id: 'm',
        email: null,
        kind: 'apiKey',
        plan: MOPILOT_PLAN,
        left: null,
        usage: { windows: [], source: 'polled', at: null, balanceMicros: 2_500_000 },
      }),
      acct({ id: 'u', harness: 'claude', unverified: true }),
      // a Console login bills per use but reads /usage as itself: its windows stay
      acct({ id: 'con', harness: 'claude', email: 'con@x.com', kind: 'apiKey', plan: 'API key', left: null }),
    ]),
    { a: { chats: 2, cli: true }, u: { cli: true } },
  ).all;
  const by = Object.fromEntries(rows.map((r: any) => [r.account.id, r]));
  assert.deepEqual(
    rows.map((r: any) => [r.key, r.state, r.status.text, r.short, r.action]),
    [
      ['codex:a', 'signed-in', '70% left (5h)', '70% left', null],
      ['codex:b', 'signed-in', 'Usage unknown', null, 'use'],
      ['codex:c', 'lapsed', 'Sign-in expired', null, 'relogin'],
      ['claude:mv', 'lapsed', 'Needs to be confirmed again', null, 'relogin'],
      ['codex:d', 'limited', 'Limit reached', 'Limit reached', 'use'],
      ['codex:e', 'billed', 'Billed per token', null, 'use'],
      ['codex:m', 'billed', '$2.50 left', '$2.50 left', 'use'],
      ['claude:u', 'unverified', 'Account unverified · 70% left', null, 'verify'],
      ['claude:con', 'billed', 'Billed per token', null, 'use'],
    ],
  );
  // meters only for a login's own windows: a lapsed login, a key (no reading) and the credits have none
  assert.equal(by.a.windows.length, 2);
  assert.equal(by.d.windows.length, 2);
  assert.deepEqual([by.c.windows, by.e.windows, by.m.windows], [[], [], []]);
  assert.equal(by.con.windows.length, 2);
  // the plan is dropped where it repeats the name
  assert.deepEqual([by.a.plan, by.e.name, by.e.plan, by.m.name, by.m.plan], ['Pro', 'API key', null, MOPILOT_PLAN, null]);
  // the CLI's own login, never by an email that is not confirmed; chats it serves
  assert.deepEqual([by.a.cli, by.a.chats, by.b.cli, by.b.chats, by.u.cli], ['Codex login on this computer', 2, null, 0, null]);
  assert.equal(by.u.name, 'Claude Code login');
  assert.match(by.mv.note, /data folder moved/);
  assert.deepEqual([by.a.note, by.c.note], [null, null]);
  assert.equal(by.a.active, true);
});

test('the login in use says "Checking…" everywhere while its harness checks it again; the others keep theirs', () => {
  const v = harnessAccountView({ ...ready, state: 'detecting' }, viewOf([acct(), acct({ id: 'b', email: 'b@x.com' })]));
  assert.equal(v.phase, 'checking');
  const active = v.active!;
  assert.deepEqual([active.state, active.status, active.short], ['checking', { text: 'Checking…', tone: 'muted' }, 'Checking…']);
  // its last usage still draws
  assert.equal(active.windows.length, 2);
  assert.equal(v.all[1].state, 'signed-in');
  assert.equal(v.empty, null);
});

test('with no account in use every surface says the same thing, by phase', () => {
  const none = viewOf([], null);
  const empty = (st: any) => harnessAccountView({ ...ready, ...st }, none).empty;
  assert.deepEqual(empty({ state: 'detecting', idle: true }), { title: 'Starts on first use', hint: IDLE_HINT });
  assert.deepEqual(empty({ state: 'detecting' }), { title: 'Checking…', hint: null });
  assert.deepEqual(empty({ state: 'signin' }), { title: 'Not signed in', hint: null });
  assert.deepEqual(empty({ state: 'missing' }), { title: 'Not installed', hint: null });
  assert.deepEqual(empty({ state: 'error' }), { title: 'No account yet', hint: null });
  assert.deepEqual(empty({ state: 'ready' }), { title: 'No account yet', hint: null });
  const v = harnessAccountView({ ...ready, state: 'error', error: 'first line\nsecond' }, none);
  assert.deepEqual([v.active, v.error, v.label, v.apiKey, v.multi], [null, 'first line', 'Codex', false, true]);
  assert.equal(harnessAccountView({ ...ready, state: 'apikey' }, none).apiKey, true);
});

test('the account in use counts even when the list leaves it out, and a chat finds the account it runs on', () => {
  const credits = acct({ id: 'm', email: null, kind: 'apiKey', plan: MOPILOT_PLAN, left: null });
  const other = acct({ id: 'b', email: 'b@x.com' });
  const v = harnessAccountView(ready, viewOf([other], credits));
  assert.equal(v.active?.key, 'codex:m');
  assert.equal(v.active?.active, true);
  // the switcher lists logins, never the credits
  const listed = harnessAccountView(ready, viewOf([other, credits], credits));
  assert.deepEqual(
    listed.accounts.map((r: any) => r.key),
    ['codex:b'],
  );
  assert.equal(servingRow(listed, 'b')?.key, 'codex:b');
  assert.equal(servingRow(listed, 'gone')?.key, 'codex:m');
  assert.equal(servingRow(listed, null)?.key, 'codex:m');
});

test('a basic harness is managed by itself; MoPilot credits read the same everywhere', () => {
  assert.deepEqual(basicAccountView({ id: 'oc', label: 'opencode', state: 'admitted' }), {
    id: 'oc',
    label: 'opencode',
    state: { text: 'Ready', tone: 'ok' },
    managedBy: 'Managed by opencode',
    managedNote: "Managed by opencode: it signs in and bills on its own. MoPilot can't see its usage.",
    line: 'Managed by opencode · Ready',
    tone: '',
    signedOut: false,
  });
  const out = basicAccountView({ id: 'k', label: 'Kimi', state: 'signin' });
  assert.deepEqual([out.line, out.tone, out.signedOut], ['Managed by Kimi · Not signed in', 'warn', true]);
  for (const [state, word] of [
    ['checking', 'Checking…'],
    ['unsupported', 'Not supported'],
    ['off', 'Turned off'],
    ['missing', 'Not installed'],
  ] as const)
    assert.equal(basicAccountView({ id: 'k', label: 'Kimi', state }).line, `Managed by Kimi · ${word}`);
  assert.deepEqual(creditsView({ signedIn: true, signingIn: true, user: { email: 'me@x' }, balanceMicros: 12_340_000 }), {
    signedIn: true,
    signingIn: true,
    email: 'me@x',
    balance: '$12.34',
    line: 'MoPilot credits · $12.34 left · me@x',
    empty: null,
  });
  assert.deepEqual(creditsView({ signedIn: false, user: null, balanceMicros: null }), {
    signedIn: false,
    signingIn: false,
    email: null,
    balance: '—',
    line: 'MoPilot credits · — left',
    empty: 'Not signed in',
  });
});

test('a login folded into the same server account is that row: its chats and CLI login count there (#1312)', () => {
  const b = acct({ id: 'b', email: 'dz@x.com' });
  const v = harnessAccountView(ready, { ...viewOf([b]), same: { default: 'b' } }, { default: { cli: true, chats: 2 }, b: { chats: 1 } });
  assert.deepEqual(
    v.all.map((r: any) => [r.key, r.cli, r.chats]),
    [['codex:b', 'Codex login on this computer', 3]],
  );
  assert.deepEqual(v.same, { default: 'b' });
  // a chat on the folded login is served by the row of its account
  assert.equal(servingRow(v, 'default')?.key, 'codex:b');
  // a fold with nothing known of either login adds an empty entry, and a view with no fold says so
  const bare = harnessAccountView(ready, { ...viewOf([b]), same: { gone: 'b' } });
  assert.deepEqual([bare.all[0].cli, bare.all[0].chats], [null, 0]);
  assert.deepEqual(harnessAccountView(ready, viewOf([b])).same, {});
});

test('with Automatic on, a limited login stands in for the usable one of its kind with the most left (#4339)', () => {
  const out = acct({
    id: 'out',
    harness: 'claude',
    email: 'out@x.com',
    left: 0,
    limited: { resetsAt: null },
  });
  const v = harnessAccountView(
    ready,
    viewOf(
      [
        out,
        acct({ id: 'low', harness: 'claude', email: 'low@x.com', left: 20 }),
        acct({ id: 'high', harness: 'claude', email: 'high@x.com', left: 67 }),
        acct({
          id: 'key',
          harness: 'claude',
          email: null,
          kind: 'apiKey',
          plan: 'API key',
          left: null,
        }),
        acct({
          id: 'gone',
          harness: 'claude',
          email: 'gone@x.com',
          status: 'expired',
          left: 100,
        }),
      ],
      out,
      'claude',
    ),
  );
  const shown = servingRow(v, null);
  assert.equal(shown?.short, 'Limit reached');
  const stand = standInRow(v, shown, true, false);
  assert.equal(stand?.key, 'claude:high');
  assert.equal(stand?.short, '67% left');
  // a pin, Automatic off or nothing to move to keeps the limited login; a usable one is never replaced
  assert.equal(standInRow(v, shown, true, true)?.key, 'claude:out');
  assert.equal(standInRow(v, shown, false, false)?.key, 'claude:out');
  assert.equal(standInRow(v, servingRow(v, 'low'), true, false)?.key, 'claude:low');
  assert.equal(standInRow(v, null, true, false), null);
  const alone = harnessAccountView(ready, viewOf([out, acct({ id: 'k2', kind: 'apiKey', plan: 'API key', left: null })], out));
  assert.equal(standInRow(alone, alone.active, true, false)?.key, 'claude:out');
  // an unread login counts as full, the one in use first among equals
  const unread = harnessAccountView(
    ready,
    viewOf([out, acct({ id: 'u', email: 'u@x.com', left: null }), acct({ id: 'f', email: 'f@x.com', left: 100 })], out),
  );
  assert.equal(standInRow(unread, unread.active, true, false)?.key, 'codex:u');
});
